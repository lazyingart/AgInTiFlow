import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOCUMENT_EXTENSIONS = new Set([".csv", ".json", ".md", ".rst", ".tsv", ".txt", ".yaml", ".yml"]);
const SOURCE_DIRECTORY_NAMES = new Set(["input", "inputs", "material", "materials", "notes", "reference", "references", "source", "sources"]);
const ROOT_SOURCE_NAMES = /^(?:agents?|brief|project[-_ ]?notes?|readme|requirements?|style[-_ ]?notes?|task)(?:\.[^.]+)?$/i;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".aginti",
  ".aginti-preview",
  ".aginti-sessions",
  ".git",
  ".venv",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "outputs",
  "temp",
  "tmp",
]);
const INTENTIONAL_SPARSE_PAGE_PATTERN =
  /^(?:appendix|approval|approvals|acknowledgements?|back cover|contact|notes|references|sign[- ]?off|signatures?)\b/i;
const HISTORICAL_TRANSITION_PATTERN =
  /\b(?:formerly|no longer|previously|replac(?:ed|ing)|superseded|used to be)\b/i;
const MIN_READABLE_MEDIAN_WORD_HEIGHT_PT = 8.8;

function portablePath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeXml(value = "") {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textFromDocumentXml(xml = "") {
  return decodeXml(
    String(xml || "")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedComparableText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function containsLiteral(text = "", literal = "") {
  const normalizedText = normalizedComparableText(text);
  const normalizedLiteral = normalizedComparableText(literal);
  if (!normalizedText || !normalizedLiteral) return false;
  const escaped = normalizedLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(
    normalizedText
  );
}

function cleanedSupersededLiteral(value = "") {
  return String(value || "")
    .replace(/^[\s:;,()\[\]-]+|[\s:;,()\[\].-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSupersededLiterals(sourceText = "") {
  const text = String(sourceText || "");
  const values = [];
  const add = (value) => {
    const cleaned = cleanedSupersededLiteral(value);
    if (cleaned.length < 2 || cleaned.length > 80) return;
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
    values.push(cleaned);
  };

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/u)) {
    if (/\b(?:correction|corrected|revis(?:ed|ion)|update(?:d)?)\b/i.test(sentence)) {
      for (const match of sentence.matchAll(
        /\bnot\s+((?:[A-Z][\p{L}.'-]+(?:\s+\d{1,2}(?:,\s*\d{4})?)?)|(?:(?:HKD|USD|EUR|GBP|JPY|CNY|RMB)\s*[\d,.]+)|(?:[A-Z][\p{L}\p{N}&.'/-]*(?:\s+[A-Z][\p{L}\p{N}&.'/-]*){0,4}))/gu
      )) {
        add(match[1]);
      }
    }
    for (const match of sentence.matchAll(
      /\breplac(?:ed|ing)\s+([A-Z][\p{L}\p{N}&.'/-]*(?:\s+[A-Z][\p{L}\p{N}&.'/-]*){0,4})/gu
    )) {
      add(match[1]);
    }
    for (const match of sentence.matchAll(
      /([A-Z][\p{L}\p{N}&.'/-]*(?:\s+[A-Z][\p{L}\p{N}&.'/-]*){0,4})\s+(?:is|was)\s+no longer\b/gu
    )) {
      add(match[1]);
    }
    if (/\bpreliminary\b/i.test(sentence)) {
      for (const match of sentence.matchAll(
        /(?:(?:HKD|USD|EUR|GBP|JPY|CNY|RMB)\s*[\d,.]+|[$€£¥]\s*[\d,.]+)/gu
      )) {
        add(match[0]);
      }
    }
  }

  const seen = new Set();
  return values.filter((value) => {
    const key = normalizedComparableText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePdfBboxPages(bboxXml = "") {
  const pages = [];
  const pagePattern = /<page\b[^>]*width="([^"]+)"[^>]*height="([^"]+)"[^>]*>([\s\S]*?)<\/page>/gi;
  for (const pageMatch of String(bboxXml || "").matchAll(pagePattern)) {
    const width = Number(pageMatch[1]);
    const height = Number(pageMatch[2]);
    const words = [];
    const wordPattern =
      /<word\b[^>]*xMin="([^"]+)"[^>]*yMin="([^"]+)"[^>]*xMax="([^"]+)"[^>]*yMax="([^"]+)"[^>]*>([\s\S]*?)<\/word>/gi;
    for (const wordMatch of pageMatch[3].matchAll(wordPattern)) {
      words.push({
        xMin: Number(wordMatch[1]),
        yMin: Number(wordMatch[2]),
        xMax: Number(wordMatch[3]),
        yMax: Number(wordMatch[4]),
        text: decodeXml(wordMatch[5]).replace(/<[^>]+>/g, "").trim(),
      });
    }
    pages.push({ width, height, words });
  }
  return pages;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluatePdfPageBalance(bboxXml = "") {
  const pages = parsePdfBboxPages(bboxXml);
  const metrics = pages.map((page, index) => {
    const footerCutoff = Number.isFinite(page.height) ? page.height - 60 : Number.POSITIVE_INFINITY;
    const contentWords = page.words.filter((word) => word.text && word.yMin < footerCutoff);
    const yValues = contentWords.flatMap((word) => [word.yMin, word.yMax]).filter(Number.isFinite);
    const usableHeight = Math.max(1, Number(page.height || 0) - 120);
    const occupiedHeight = yValues.length ? Math.max(...yValues) - Math.min(...yValues) : 0;
    const wordHeights = contentWords
      .map((word) => word.yMax - word.yMin)
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      page: index + 1,
      wordCount: contentWords.length,
      occupiedRatio: occupiedHeight / usableHeight,
      medianWordHeight: median(wordHeights),
      leadingText: contentWords.slice(0, 16).map((word) => word.text).join(" ").trim(),
    };
  });
  const defects = [];
  const documentMedianWordHeight = median(
    metrics.flatMap((item) => Array(item.wordCount).fill(item.medianWordHeight))
  );
  if (documentMedianWordHeight > 0 && documentMedianWordHeight < MIN_READABLE_MEDIAN_WORD_HEIGHT_PT) {
    defects.push({
      code: "undersized-document-text",
      message: `The document's median rendered word height is ${documentMedianWordHeight.toFixed(1)} pt, below the ${MIN_READABLE_MEDIAN_WORD_HEIGHT_PT.toFixed(1)} pt readability floor. Keep normal body type and rebalance coherent sections across pages instead of shrinking text to force a page count.`,
    });
  }
  if (metrics.length > 1) {
    const priorWordCounts = metrics.slice(0, -1).map((item) => item.wordCount).filter((value) => value > 0);
    const last = metrics.at(-1);
    const comparisonCount = Math.max(80, median(priorWordCounts) * 0.45);
    const intentionalSparsePage = INTENTIONAL_SPARSE_PAGE_PATTERN.test(last.leadingText);
    if (
      !intentionalSparsePage &&
      last.wordCount > 0 &&
      last.wordCount < comparisonCount &&
      last.occupiedRatio < 0.35
    ) {
      defects.push({
        code: "sparse-trailing-page",
        message: `Page ${last.page} is a sparse spill page (${last.wordCount} words; ${(last.occupiedRatio * 100).toFixed(0)}% usable-height occupancy). Reflow the preceding content or rebalance sections so the final page is intentional and useful.`,
      });
    }
  }
  return {
    ok: pages.length > 0 && defects.length === 0,
    checked: pages.length > 0,
    pages: metrics,
    documentMedianWordHeight,
    defects,
  };
}

export function evaluateCurrentStateText({ sourceText = "", outputText = "", currentStateRequired = false } = {}) {
  const supersededLiterals = extractSupersededLiterals(sourceText);
  const presentSupersededLiterals = supersededLiterals.filter((literal) => containsLiteral(outputText, literal));
  const defects = [];
  if (presentSupersededLiterals.length) {
    defects.push({
      code: "superseded-facts-present",
      message: `The reader-facing document still contains superseded source values: ${presentSupersededLiterals.join(", ")}. State only the authoritative current values unless history was explicitly requested.`,
    });
  }
  if (currentStateRequired) {
    const historicalMarkers = [...new Set(
      (String(outputText || "").match(new RegExp(HISTORICAL_TRANSITION_PATTERN.source, "gi")) || [])
        .map((value) => value.toLowerCase())
    )];
    if (historicalMarkers.length) {
      defects.push({
        code: "historical-transition-prose",
        message: `This is a current-state document, but it narrates superseded history (${historicalMarkers.join(", ")}). Remove transition commentary and retain only current decisions.`,
      });
    }
  }
  return { ok: defects.length === 0, defects, supersededLiterals, presentSupersededLiterals };
}

async function collectSourceDocuments(commandCwd) {
  const documents = [];
  let totalBytes = 0;
  const maxFiles = 128;
  const maxTotalBytes = 4 * 1024 * 1024;
  const maxFileBytes = 512 * 1024;

  async function visit(directory, sourceRoot = false, depth = 0) {
    if (documents.length >= maxFiles || totalBytes >= maxTotalBytes || depth > 5) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (documents.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      const absolutePath = path.join(directory, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(lowerName)) continue;
        const nextSourceRoot = sourceRoot || SOURCE_DIRECTORY_NAMES.has(lowerName);
        if (nextSourceRoot) await visit(absolutePath, true, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(lowerName);
      const rootCandidate = directory === commandCwd && ROOT_SOURCE_NAMES.test(entry.name);
      if (!(sourceRoot && DOCUMENT_EXTENSIONS.has(extension)) && !rootCandidate) continue;
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.size <= 0 || stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) continue;
        const text = await fs.readFile(absolutePath, "utf8");
        documents.push({ path: portablePath(path.relative(commandCwd, absolutePath)), text });
        totalBytes += stat.size;
      } catch {
        // Unreadable source material is left to the existing source-coverage gate.
      }
    }
  }

  await visit(commandCwd, false, 0);
  return documents;
}

function artifactCandidatesFromText(text = "") {
  const candidates = [];
  const pattern = /(?:`([^`\n]+\.(?:docx|pdf))`|((?:\.?\.?\/[\w .()\/-]+|[\w.-]+(?:\/[\w .()\/-]+)*)\.(?:docx|pdf)))/gi;
  for (const match of String(text || "").matchAll(pattern)) {
    const candidate = String(match[1] || match[2] || "").trim().replace(/[),.;:]+$/g, "");
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function collectOutputDirectoryCandidates(commandCwd) {
  const candidates = [];
  for (const name of ["output", "outputs"]) {
    const root = path.join(commandCwd, name);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 80)) {
      if (!entry.isFile() || !/\.(?:docx|pdf)$/i.test(entry.name)) continue;
      candidates.push(portablePath(path.join(name, entry.name)));
    }
  }
  return candidates;
}

async function resolveExistingArtifacts(commandCwd, values = []) {
  const artifacts = [];
  const seen = new Set();
  for (const value of values) {
    const absolutePath = path.resolve(commandCwd, String(value || ""));
    if (!isInsideRoot(commandCwd, absolutePath) || seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size <= 0) continue;
      artifacts.push({
        path: portablePath(path.relative(commandCwd, absolutePath)),
        absolutePath,
        extension: path.extname(absolutePath).toLowerCase(),
        size: stat.size,
      });
    } catch {
      // Missing candidates are reported only when no document artifact exists.
    }
  }
  return artifacts;
}

async function extractPdf(artifact) {
  const [textResult, bboxResult] = await Promise.all([
    execFileAsync("pdftotext", [artifact.absolutePath, "-"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
    }),
    execFileAsync("pdftotext", ["-bbox", artifact.absolutePath, "-"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    }),
  ]);
  return { text: textResult.stdout, bbox: bboxResult.stdout };
}

async function extractDocxText(artifact) {
  const script = [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as archive:",
    "    sys.stdout.buffer.write(archive.read('word/document.xml'))",
  ].join("\n");
  const result = await execFileAsync("python3", ["-c", script, artifact.absolutePath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
  });
  return textFromDocumentXml(result.stdout);
}

function currentStateRequested(goal = "", sourceText = "") {
  const contractText = `${goal}\n${sourceText}`;
  return /\b(?:authoritative current|current state|latest explicit correction|latest correction|superseded|use the latest)\b/i.test(
    contractText
  );
}

export async function validateWordDocumentArtifacts({
  commandCwd = process.cwd(),
  candidateResult = "",
  goal = "",
  exactOutputPaths = [],
} = {}) {
  const workspace = path.resolve(commandCwd || process.cwd());
  const outputCandidates = [
    ...(Array.isArray(exactOutputPaths) ? exactOutputPaths : []),
    ...artifactCandidatesFromText(candidateResult),
    ...(await collectOutputDirectoryCandidates(workspace)),
  ];
  const artifacts = await resolveExistingArtifacts(workspace, outputCandidates);
  const relevantArtifacts = artifacts.filter((item) => [".docx", ".pdf"].includes(item.extension));
  const defects = [];
  if (!relevantArtifacts.length) {
    return {
      ok: false,
      checked: true,
      artifacts: [],
      defects: [{
        code: "missing-document-artifact",
        message: "The Word/document task claimed completion without a readable DOCX or PDF artifact in the declared output paths or output directory.",
      }],
      reason: "No readable DOCX or PDF artifact was found for the completed document task.",
    };
  }

  const sourceDocuments = await collectSourceDocuments(workspace);
  const sourceText = sourceDocuments.map((item) => item.text).join("\n\n");
  const currentStateRequired = currentStateRequested(goal, sourceText);
  const artifactReports = [];
  for (const artifact of relevantArtifacts) {
    try {
      if (artifact.extension === ".pdf") {
        const extracted = await extractPdf(artifact);
        const semantic = evaluateCurrentStateText({ sourceText, outputText: extracted.text, currentStateRequired });
        const pageBalance = evaluatePdfPageBalance(extracted.bbox);
        if (!String(extracted.text || "").trim()) {
          defects.push({
            code: "empty-pdf-text",
            path: artifact.path,
            message: "The PDF has no independently extractable reader text.",
          });
        }
        if (!pageBalance.checked) {
          defects.push({
            code: "pdf-page-geometry-unavailable",
            path: artifact.path,
            message: "The PDF page geometry could not be extracted, so page balance and clipping cannot be verified.",
          });
        }
        defects.push(...semantic.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...pageBalance.defects.map((item) => ({ ...item, path: artifact.path })));
        artifactReports.push({
          path: artifact.path,
          extension: artifact.extension,
          textChars: extracted.text.length,
          pageCount: pageBalance.pages.length,
          pages: pageBalance.pages,
          supersededLiterals: semantic.supersededLiterals,
        });
      } else {
        const text = await extractDocxText(artifact);
        const semantic = evaluateCurrentStateText({ sourceText, outputText: text, currentStateRequired });
        if (!String(text || "").trim()) {
          defects.push({
            code: "empty-docx-text",
            path: artifact.path,
            message: "The DOCX has no independently extractable editable document text.",
          });
        }
        defects.push(...semantic.defects.map((item) => ({ ...item, path: artifact.path })));
        artifactReports.push({
          path: artifact.path,
          extension: artifact.extension,
          textChars: text.length,
          supersededLiterals: semantic.supersededLiterals,
        });
      }
    } catch (error) {
      defects.push({
        code: "document-extraction-failed",
        path: artifact.path,
        message: `Could not independently extract and inspect ${artifact.path}: ${String(error?.message || error).slice(0, 300)}.`,
      });
    }
  }

  const uniqueDefects = [];
  const defectKeys = new Set();
  for (const defect of defects) {
    const key = `${defect.code}\n${defect.message}`;
    if (defectKeys.has(key)) continue;
    defectKeys.add(key);
    uniqueDefects.push(defect);
  }
  return {
    ok: uniqueDefects.length === 0,
    checked: true,
    artifacts: artifactReports,
    sourcePaths: sourceDocuments.map((item) => item.path),
    currentStateRequired,
    defects: uniqueDefects,
    reason: uniqueDefects.length
      ? uniqueDefects.map((item) => `${item.path ? `${item.path}: ` : ""}${item.message}`).join(" ")
      : `Independent document checks passed for ${artifactReports.map((item) => item.path).join(", ")}.`,
  };
}
