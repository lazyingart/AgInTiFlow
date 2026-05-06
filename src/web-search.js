import { isDomainAllowed } from "./guardrails.js";
import { redactSensitiveText } from "./redaction.js";

const MAX_QUERY_BYTES = 500;
const MAX_RESULTS = 10;

function decodeHtml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDuckDuckGoHref(href = "") {
  const decoded = decodeHtml(href);
  try {
    const parsed = new URL(decoded, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (/^https?:\/\//i.test(decoded)) return decoded;
    return parsed.href;
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoHtml(html, maxResults, allowedDomains = []) {
  const results = [];
  const blocks = String(html || "").split(/<div class="result\b/i).slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = normalizeDuckDuckGoHref(anchor[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    if (!isDomainAllowed(url, allowedDomains)) continue;
    const snippet = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: decodeHtml(anchor[2]).slice(0, 220),
      url,
      snippet: snippet ? decodeHtml(snippet[1]).slice(0, 420) : "",
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export async function searchWeb(args = {}, config = {}) {
  const query = String(args.query || "").trim();
  if (!query) return { ok: false, toolName: "web_search", error: "Search query is required." };
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    return { ok: false, toolName: "web_search", error: "Search query is too large." };
  }

  const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), MAX_RESULTS);
  const allowedDomains = Array.isArray(args.domains) && args.domains.length ? args.domains : config.allowedDomains || [];
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (config.webSearchDryRun) {
    return {
      ok: true,
      toolName: "web_search",
      query,
      provider: "duckduckgo-html",
      searchUrl,
      dryRun: true,
      results: [
        {
          title: `Dry-run search result for ${query}`,
          url: "https://example.com/agintiflow-web-search-smoke",
          snippet: "Deterministic web_search dry-run result.",
        },
      ].slice(0, maxResults),
    };
  }

  try {
    const response = await fetch(searchUrl, {
      signal: config.abortSignal || AbortSignal.timeout(Number(args.timeoutMs) || 12000),
      headers: {
        "User-Agent": "AgInTiFlow/1.0 (+https://flow.lazying.art)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await response.text();
    const results = parseDuckDuckGoHtml(html, maxResults, allowedDomains);
    return {
      ok: true,
      toolName: "web_search",
      query: redactSensitiveText(query),
      provider: "duckduckgo-html",
      status: response.status,
      searchUrl,
      results,
      note: results.length ? "" : "No results parsed. The search URL is included as fallback.",
    };
  } catch (error) {
    return {
      ok: false,
      toolName: "web_search",
      query: redactSensitiveText(query),
      provider: "duckduckgo-html",
      searchUrl,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}
