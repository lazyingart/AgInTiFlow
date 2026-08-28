import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SHEET_NAME_PATTERN = /^Sheet\d*$/i;
const OUTPUT_DIRECTORY_NAMES = ["artifacts", "deliverables", "output", "outputs"];
const XLSX_INSPECTOR = String.raw`
import json, posixpath, sys, zipfile
import xml.etree.ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    names = set(archive.namelist())
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        item.attrib.get("Id", ""): item.attrib.get("Target", "")
        for item in relationships.findall(f"{{{PKG_REL}}}Relationship")
    }
    sheets = []
    for item in workbook.findall(f".//{{{MAIN}}}sheet"):
        relation_id = item.attrib.get(f"{{{DOC_REL}}}id", "")
        target = targets.get(relation_id, "")
        if target.startswith("/"):
            worksheet_path = target.lstrip("/")
        else:
            worksheet_path = posixpath.normpath(posixpath.join("xl", target))
        cells = []
        formulas = []
        rows = []
        if worksheet_path in names:
            worksheet = ET.fromstring(archive.read(worksheet_path))
            cells = worksheet.findall(f".//{{{MAIN}}}c")
            formulas = worksheet.findall(f".//{{{MAIN}}}f")
            rows = worksheet.findall(f".//{{{MAIN}}}row")
        sheets.append({
            "name": item.attrib.get("name", ""),
            "state": item.attrib.get("state", "visible"),
            "path": worksheet_path,
            "cellCount": len(cells),
            "formulaCount": len(formulas),
            "rowCount": len(rows),
        })
    print(json.dumps({
        "sheets": sheets,
        "chartCount": sum(1 for name in names if name.startswith("xl/charts/") and name.endswith(".xml")),
        "externalLinkCount": sum(1 for name in names if name.startswith("xl/externalLinks/") and name.endswith(".xml")),
        "hasMacros": "xl/vbaProject.bin" in names,
    }, ensure_ascii=False))
`;

function portablePath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function workbookPathsFromText(value = "") {
  const paths = [];
  const pattern = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.xlsx)(?=$|[\s`'"),.;:])/gi;
  for (const match of String(value || "").matchAll(pattern)) {
    const candidate = portablePath(match[1]).replace(/^\.\//, "");
    if (candidate && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

async function shallowWorkbookCandidates(workspace) {
  const results = [];
  for (const relativeDirectory of ["", ...OUTPUT_DIRECTORY_NAMES]) {
    const directory = path.join(workspace, relativeDirectory);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".xlsx")) continue;
      results.push(portablePath(path.join(relativeDirectory, entry.name)));
    }
  }
  return results;
}

async function inspectWorkbook(absolutePath) {
  const result = await execFileAsync("python3", ["-c", XLSX_INSPECTOR, absolutePath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 20_000,
  });
  return JSON.parse(String(result.stdout || "{}"));
}

export function evaluateSpreadsheetStructure(report = {}) {
  const sheets = Array.isArray(report.sheets) ? report.sheets : [];
  const defects = [];
  if (!sheets.length) {
    defects.push({
      code: "workbook-has-no-worksheets",
      message: "The workbook does not contain a readable worksheet.",
    });
  } else if (sheets.every((sheet) => Number(sheet?.cellCount || 0) === 0)) {
    defects.push({
      code: "workbook-has-no-content",
      message: "The workbook contains no populated cells.",
    });
  }
  if (sheets.length > 1) {
    for (const sheet of sheets) {
      if (
        String(sheet?.state || "visible") === "visible" &&
        DEFAULT_SHEET_NAME_PATTERN.test(String(sheet?.name || "")) &&
        Number(sheet?.cellCount || 0) === 0
      ) {
        defects.push({
          code: "unused-default-worksheet",
          sheet: String(sheet.name || ""),
          message: `The workbook retains an empty default worksheet named ${sheet.name}. Remove the placeholder in the canonical producer so every rebuild contains only purposeful sheets.`,
        });
      }
    }
  }
  if (Number(report.externalLinkCount || 0) > 0) {
    defects.push({
      code: "external-workbook-links",
      message: "The workbook contains external links, so its calculations are not self-contained and reproducible.",
    });
  }
  if (report.hasMacros === true) {
    defects.push({
      code: "macro-payload-in-xlsx",
      message: "The XLSX package unexpectedly contains a VBA macro payload.",
    });
  }
  return {
    ok: defects.length === 0,
    checked: true,
    sheets,
    formulaCount: sheets.reduce((sum, sheet) => sum + Number(sheet?.formulaCount || 0), 0),
    chartCount: Math.max(0, Number(report.chartCount || 0)),
    defects,
  };
}

export async function validateSpreadsheetArtifacts({
  commandCwd = process.cwd(),
  candidateResult = "",
  goal = "",
  exactOutputPaths = [],
} = {}) {
  const workspace = path.resolve(commandCwd || process.cwd());
  const declared = (Array.isArray(exactOutputPaths) ? exactOutputPaths : [])
    .map(portablePath)
    .filter((item) => item.toLowerCase().endsWith(".xlsx"));
  const mentioned = workbookPathsFromText(candidateResult);
  const discovered = declared.length || mentioned.length || !/\b(?:excel|spreadsheet|workbook|xlsx)\b/i.test(goal)
    ? []
    : await shallowWorkbookCandidates(workspace);
  const candidates = [...new Set([...declared, ...mentioned, ...discovered])];
  if (!candidates.length) {
    return {
      ok: true,
      checked: false,
      artifacts: [],
      defects: [],
      reason: "No current XLSX artifact required structural validation.",
    };
  }

  const artifacts = [];
  const defects = [];
  for (const candidate of candidates) {
    const absolutePath = path.resolve(workspace, candidate);
    if (!isInsideRoot(workspace, absolutePath)) {
      defects.push({
        code: "spreadsheet-outside-workspace",
        path: candidate,
        message: `The workbook ${candidate} is outside the configured workspace.`,
      });
      continue;
    }
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      defects.push({
        code: "missing-spreadsheet-artifact",
        path: candidate,
        message: `The workbook ${candidate} does not exist.`,
      });
      continue;
    }
    try {
      const structure = evaluateSpreadsheetStructure(await inspectWorkbook(absolutePath));
      artifacts.push({
        path: portablePath(path.relative(workspace, absolutePath)),
        sheets: structure.sheets,
        formulaCount: structure.formulaCount,
        chartCount: structure.chartCount,
      });
      defects.push(...structure.defects.map((item) => ({
        ...item,
        path: portablePath(path.relative(workspace, absolutePath)),
      })));
    } catch (error) {
      defects.push({
        code: "spreadsheet-extraction-failed",
        path: candidate,
        message: `Could not independently inspect ${candidate}: ${String(error?.message || error).slice(0, 300)}.`,
      });
    }
  }

  return {
    ok: defects.length === 0 && artifacts.length > 0,
    checked: true,
    artifacts,
    defects,
    reason: defects.length
      ? defects.map((item) => `${item.path ? `${item.path}: ` : ""}${item.message}`).join(" ")
      : artifacts.length
        ? `Independent spreadsheet structure checks passed for ${artifacts.map((item) => item.path).join(", ")}.`
        : "No readable workbook artifact was available for structural validation.",
  };
}
