import { redactSensitiveText } from "./redaction.js";

const RESEARCH_TOOL_NAMES = new Set([
  "web_search",
  "read_web_page",
  "web_research",
  "deep_research",
]);

function compact(value = "", limit = 700) {
  const text = redactSensitiveText(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 16)).trimEnd()} ... [truncated]`;
}

function publicUrl(value = "") {
  const text = compact(value, 1200);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizedEntry(value = {}) {
  const entry = {
    toolName: compact(value.toolName, 40),
    query: compact(value.query, 320),
    title: compact(value.title, 260),
    url: publicUrl(value.url),
    excerpt: compact(value.excerpt, 760),
    publishedAt: compact(value.publishedAt, 80),
    retrievedAt: compact(value.retrievedAt, 80),
    sha256: /^[a-f0-9]{16,128}$/i.test(String(value.sha256 || ""))
      ? String(value.sha256).toLowerCase()
      : "",
    reportPath: compact(value.reportPath, 520),
  };
  if (!entry.title && !entry.url && !entry.excerpt && !entry.reportPath) return null;
  return Object.fromEntries(Object.entries(entry).filter(([, item]) => item));
}

function sourceEntries(toolResult = {}) {
  const toolName = compact(toolResult.toolName, 40);
  const query = compact(toolResult.query || toolResult.args?.query || toolResult.args?.question, 320);
  const entries = [];
  const appendSources = (sources = []) => {
    for (const source of Array.isArray(sources) ? sources.slice(0, 8) : []) {
      const entry = normalizedEntry({
        toolName,
        query,
        title: source?.title,
        url: source?.canonicalUrl || source?.url,
        excerpt: source?.snippet || source?.excerpt || source?.text,
        publishedAt: source?.publishedAt,
        retrievedAt: toolResult.retrievedAt,
      });
      if (entry) entries.push(entry);
    }
  };

  if (toolName === "web_search") appendSources(toolResult.results);
  if (toolName === "web_research") {
    appendSources(toolResult.sources || toolResult.search?.results);
    const summary = normalizedEntry({
      toolName,
      query,
      title: `Research synthesis: ${query}`,
      excerpt: toolResult.answer,
      reportPath: toolResult.artifactPath,
    });
    if (summary) entries.push(summary);
  }
  if (toolName === "read_web_page") {
    const passages = Array.isArray(toolResult.passages)
      ? toolResult.passages.slice(0, 3).join(" ")
      : "";
    const entry = normalizedEntry({
      toolName,
      query,
      title: toolResult.title,
      url: toolResult.canonicalUrl || toolResult.url || toolResult.requestedUrl,
      excerpt: passages || toolResult.content,
      publishedAt: toolResult.publishedAt,
      retrievedAt: toolResult.retrievedAt,
      sha256: toolResult.sha256,
    });
    if (entry) entries.push(entry);
  }
  if (toolName === "deep_research") {
    appendSources(toolResult.sources || toolResult.evidence?.sources);
    const summary = normalizedEntry({
      toolName,
      query,
      title: `Completed deep research: ${query}`,
      excerpt: toolResult.answer,
      reportPath: toolResult.reportPath || toolResult.artifactPath,
    });
    if (summary) entries.push(summary);
  }
  return entries;
}

function evidenceKey(entry = {}) {
  return entry.url || [entry.toolName, entry.query, entry.title, entry.reportPath].join("|");
}

export function mergeDurableResearchEvidence(existing = [], incoming = [], limit = 24) {
  const merged = new Map();
  const append = (raw = {}) => {
    const entry = normalizedEntry(raw);
    if (!entry) return;
    const key = evidenceKey(entry);
    const prior = merged.get(key) || {};
    if (merged.has(key)) merged.delete(key);
    merged.set(key, Object.fromEntries(
      Object.entries({ ...prior, ...entry }).filter(([, value]) => value)
    ));
  };
  for (const entry of Array.isArray(existing) ? existing : []) append(entry);
  for (const entry of Array.isArray(incoming) ? incoming : []) append(entry);
  return [...merged.values()].slice(-Math.max(1, Number(limit || 24)));
}

export function recordDurableResearchEvidence(state = {}, toolResult = {}, options = {}) {
  if (
    !toolResult ||
    toolResult.ok === false ||
    toolResult.blocked ||
    toolResult.skipped ||
    !RESEARCH_TOOL_NAMES.has(String(toolResult.toolName || ""))
  ) return [];
  const entries = sourceEntries(toolResult);
  if (!entries.length) return [];
  state.meta = state.meta || {};
  state.meta.durableResearchEvidence = mergeDurableResearchEvidence(
    state.meta.durableResearchEvidence,
    entries,
    options.limit || 24
  );
  return entries;
}

export function formatDurableResearchEvidence(entries = [], limit = 18) {
  return (Array.isArray(entries) ? entries : [])
    .slice(-Math.max(1, Number(limit || 18)))
    .map((entry) => {
      const parts = [
        entry.title ? `title=${compact(entry.title, 260)}` : "",
        entry.url ? `url=${publicUrl(entry.url)}` : "",
        entry.publishedAt ? `published=${compact(entry.publishedAt, 80)}` : "",
        entry.query ? `query=${compact(entry.query, 260)}` : "",
        entry.excerpt ? `evidence=${compact(entry.excerpt, 700)}` : "",
        entry.reportPath ? `report=${compact(entry.reportPath, 420)}` : "",
        entry.sha256 ? `sha256=${String(entry.sha256).slice(0, 16)}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    })
    .filter(Boolean);
}
