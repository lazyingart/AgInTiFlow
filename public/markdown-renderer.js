import { readDisplayMathBlock, replaceInlineMath, startsDisplayMathBlock } from "./math-renderer.js";

export function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  );
}

function safeLinkHref(value) {
  const raw = String(value || "").trim();
  const baseUrl = globalThis.location?.origin || "http://localhost";
  try {
    const parsed = new URL(raw, baseUrl);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function renderInlineMarkdown(value) {
  const placeholders = [];
  const protect = (html) => {
    const index = placeholders.push(html) - 1;
    return `\u0000${index}\u0000`;
  };

  let text = String(value || "");
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => protect(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = safeLinkHref(href);
    if (!safeHref) return escapeHtml(label);
    return protect(
      `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    );
  });
  text = replaceInlineMath(text, protect);

  let html = escapeHtml(text);
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ""));
}

function renderMarkdownTable(headerLine, rows) {
  const headers = splitTableRow(headerLine);
  const bodyRows = rows.map(splitTableRow);
  return `
    <div class="markdown-table-wrap">
      <table>
        <thead>
          <tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${bodyRows
            .map((row) => `<tr>${headers.map((_header, index) => `<td>${renderInlineMarkdown(row[index] || "")}</td>`).join("")}</tr>`)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function isMarkdownBlockStart(line, nextLine = "") {
  const trimmed = String(line || "").trim();
  return (
    /^```/.test(trimmed) ||
    startsDisplayMathBlock(trimmed) ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^[-*_]{3,}$/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^[-*+]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    (trimmed.includes("|") && isMarkdownTableSeparator(nextLine))
  );
}

function unwrapRenderableMarkdownFence(value = "") {
  const raw = String(value || "");
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : raw;
}

export function renderMarkdown(value) {
  const lines = unwrapRenderableMarkdownFence(value).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" ").trim())}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    html.push(`<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listType = "";
    listItems = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const language = fence[1] || "";
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      html.push(
        `<pre class="markdown-code"><code data-language="${escapeHtml(language)}">${escapeHtml(code.join("\n"))}</code></pre>`
      );
      continue;
    }

    const displayMath = readDisplayMathBlock(lines, index);
    if (displayMath) {
      flushParagraph();
      flushList();
      html.push(displayMath.html);
      index = displayMath.endIndex;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    if (trimmed.includes("|") && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      flushList();
      const header = line;
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderMarkdownTable(header, rows));
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      index -= 1;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }

    if (listItems.length) flushList();
    paragraph.push(trimmed);
    if (index + 1 >= lines.length || isMarkdownBlockStart(lines[index + 1], lines[index + 2])) flushParagraph();
  }

  flushParagraph();
  flushList();
  return html.join("");
}
