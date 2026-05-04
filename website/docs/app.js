import { docsContent, docsNav, languageMeta, languages, normalizeLanguage, t } from "./i18n.js";

const pages = [
  {
    groupIndex: 0,
    items: [
      ["overview", "Overview", "docs/overview.md", "product architecture sessions workspace"],
      ["quick-start", "Quick Start", "docs/quick-start.md", "install npm aginti web mock"],
      ["project-setup", "Project Setup", "docs/project-setup.md", "init AGINTI doctor sessions"],
    ],
  },
  {
    groupIndex: 1,
    items: [
      ["cli", "Interactive CLI", "docs/cli.md", "terminal chat slash commands patch diff resume"],
      ["web-ui", "Web UI", "docs/web-ui.md", "browser panels settings controls run output"],
      ["artifacts-and-sessions", "Artifacts and Sessions", "docs/artifacts-and-sessions.md", "canvas files pdf image inbox queue"],
      ["auth-and-keys", "Auth and Keys", "docs/auth-and-keys.md", "deepseek openai qwen grsai token"],
    ],
  },
  {
    groupIndex: 2,
    items: [
      ["coding-tools", "Coding Tools", "docs/coding-tools.md", "apply_patch codebase tests diff files"],
      ["runtime-modes", "Runtime Modes", "docs/runtime-modes.md", "docker sandbox host tmux package installs"],
      ["skills", "Skills and Tools", "docs/skills.md", "profiles tools latex website image github"],
      ["aaps", "AAPS Adapter", "docs/aaps.md", "aaps workflows pipeline script large project"],
      ["web-search-scouts", "Web Search and Scouts", "docs/web-search-scouts.md", "search parallel scouts swarm blackboard"],
    ],
  },
  {
    groupIndex: 3,
    items: [
      ["self-development", "Self Development", "docs/self-development.md", "supervise self edit tmux checks"],
      ["release", "Release and Publishing", "docs/release.md", "npm publish version trusted publishing"],
      ["troubleshooting", "Troubleshooting", "docs/troubleshooting.md", "errors pytest docker provider sessions"],
    ],
  },
];

const flatPages = pages.flatMap((group) =>
  group.items.map(([id, title, file, keywords = ""]) => ({
    id,
    title,
    file,
    keywords,
    groupIndex: group.groupIndex,
  }))
);

const languageStorageKey = "agintiflow-docs-language";
let currentLanguage = normalizeLanguage(window.localStorage.getItem(languageStorageKey) || navigator.language || "en");

const treeEl = document.querySelector("#docs-tree");
const searchEl = document.querySelector("#docs-search");
const contentEl = document.querySelector("#docs-content");
const titleEl = document.querySelector("#page-title");
const descriptionEl = document.querySelector("#page-description");
const tocEl = document.querySelector("#page-toc");
const previousEl = document.querySelector("#previous-page");
const nextEl = document.querySelector("#next-page");
const languageSelect = document.querySelector("#language-select");
const tocTitle = document.querySelector("#toc-title");
const metaDescription = document.querySelector('meta[name="description"]');

function currentNav() {
  return docsNav[currentLanguage] || docsNav.en;
}

function groupLabel(groupOrPage) {
  return currentNav().groups[groupOrPage.groupIndex] || docsNav.en.groups[groupOrPage.groupIndex] || "";
}

function pageTitle(page) {
  return currentNav().pages[page.id] || page.title;
}

function translate(key, params = {}) {
  return t(currentLanguage, key, params);
}

function applyStaticLanguage() {
  const meta = languageMeta(currentLanguage);
  document.documentElement.lang = meta.code;
  document.documentElement.dir = meta.dir;
  if (metaDescription) metaDescription.content = translate("metaDescription");
  document.querySelectorAll("[data-docs-ui]").forEach((node) => {
    node.textContent = translate(node.dataset.docsUi);
  });
  if (languageSelect) {
    languageSelect.setAttribute("aria-label", translate("language"));
    languageSelect.value = currentLanguage;
  }
  if (searchEl) searchEl.placeholder = translate("searchPlaceholder");
  if (tocTitle) tocTitle.textContent = translate("onThisPage");
  document.querySelector("#copy-install").textContent = translate("copy");
}

function currentId() {
  return window.location.hash.replace(/^#\/?/, "").split("/")[0] || "overview";
}

function currentAnchor() {
  return window.location.hash.replace(/^#\/?/, "").split("/")[1] || "";
}

function pageById(id) {
  return flatPages.find((page) => page.id === id) || flatPages[0];
}

function renderTree(filter = "") {
  const needle = filter.trim().toLowerCase();
  const active = pageById(currentId()).id;
  treeEl.innerHTML = pages
    .map((group) => {
      const items = group.items
        .map(([id, title, file, keywords = ""]) => ({ id, title, file, keywords }))
        .filter(
          (item) =>
            !needle ||
            `${pageTitle(item)} ${item.title} ${item.file} ${item.keywords} ${groupLabel(group)}`.toLowerCase().includes(needle)
        );
      if (!items.length) return "";
      return `
        <section class="tree-group">
          <div class="tree-label">${escapeHtml(groupLabel(group))}</div>
          ${items
            .map(
              (item) => `
                <a class="tree-link ${item.id === active ? "active" : ""}" href="#/${item.id}">
                  <span>${escapeHtml(pageTitle(item))}</span>
                  <code>${escapeHtml(item.file)}</code>
                </a>
              `
            )
            .join("")}
        </section>
      `;
    })
    .join("");

  if (!treeEl.innerHTML.trim()) {
    treeEl.innerHTML = `<div class="empty-state">${escapeHtml(translate("noMatches"))}</div>`;
  }
}

async function loadMarkdown(page) {
  const localized = currentLanguage === "en" ? "" : docsContent[currentLanguage]?.[page.id];
  if (localized) return localized;
  const response = await fetch(page.file, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function loadPage() {
  const page = pageById(currentId());
  const title = pageTitle(page);
  renderTree(searchEl.value || "");
  titleEl.textContent = title;
  descriptionEl.textContent = translate("description", { group: groupLabel(page), file: page.file });
  contentEl.innerHTML = `<div class="empty-state">${escapeHtml(translate("loading", { title }))}</div>`;

  try {
    const markdown = await loadMarkdown(page);
    const html = renderMarkdown(markdown);
    contentEl.innerHTML = html;
    enhanceHeadings();
    renderToc(page);
    renderPager(page);
    document.title = `${title} | ${translate("titleSuffix")}`;
    const anchor = currentAnchor();
    if (anchor) {
      requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  } catch (error) {
    contentEl.innerHTML = `<div class="empty-state">${escapeHtml(translate("loadError", { file: page.file, error: error.message }))}</div>`;
    tocEl.innerHTML = "";
  }
}

function renderPager(page) {
  const index = flatPages.findIndex((item) => item.id === page.id);
  const previous = flatPages[index - 1];
  const next = flatPages[index + 1];
  previousEl.href = previous ? `#/${previous.id}` : "#";
  previousEl.innerHTML = previous ? `<span>${escapeHtml(translate("previous"))}</span><br />${escapeHtml(pageTitle(previous))}` : "";
  nextEl.href = next ? `#/${next.id}` : "#";
  nextEl.innerHTML = next ? `<span>${escapeHtml(translate("next"))}</span><br />${escapeHtml(pageTitle(next))}` : "";
}

function renderToc(page) {
  const headings = [...contentEl.querySelectorAll("h2, h3")];
  tocEl.innerHTML = headings
    .map(
      (heading) =>
        `<a href="#/${page.id}/${heading.id}" style="padding-left:${heading.tagName === "H3" ? 22 : 12}px">${escapeHtml(heading.textContent.replace("#", "").trim())}</a>`
    )
    .join("");
}

function enhanceHeadings() {
  const used = new Set();
  contentEl.querySelectorAll("h1, h2, h3").forEach((heading) => {
    const base = slugify(heading.textContent);
    let id = base || "section";
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    heading.id = id;
    if (heading.tagName !== "H1") {
      const button = document.createElement("button");
      button.className = "anchor-copy";
      button.type = "button";
      button.textContent = "#";
      button.title = translate("copySection");
      button.addEventListener("click", async () => {
        const page = pageById(currentId());
        const url = `${window.location.origin}${window.location.pathname}#/${page.id}/${id}`;
        await navigator.clipboard?.writeText(url).catch(() => {});
        button.textContent = translate("copiedSection");
        setTimeout(() => {
          button.textContent = "#";
        }, 900);
      });
      heading.appendChild(button);
    }
  });
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null;
  let inCode = false;
  let codeLang = "";
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushCode = () => {
    out.push(`<pre><code${codeLang ? ` data-language="${escapeHtml(codeLang)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    codeLang = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushParagraph();
        flushList();
        inCode = true;
        codeLang = line.replace(/^```/, "").trim();
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    const table = parseTable(lines, index);
    if (table) {
      flushParagraph();
      flushList();
      out.push(table.html);
      index += table.linesConsumed - 1;
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((unordered || ordered)[1]);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode) flushCode();
  flushParagraph();
  flushList();
  return out.join("\n");
}

function parseTable(lines, index) {
  const header = splitTableRow(lines[index]);
  const separator = splitTableRow(lines[index + 1] || "");
  if (!header || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  const rows = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const row = splitTableRow(lines[cursor]);
    if (!row) break;
    rows.push(row);
    cursor += 1;
  }
  const html = `
    <table>
      <thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  `;
  return { html, linesConsumed: cursor - index };
}

function splitTableRow(line = "") {
  if (!line.includes("|")) return null;
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function inlineMarkdown(value = "") {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

languageSelect.innerHTML = languages.map((language) => `<option value="${escapeHtml(language.code)}">${escapeHtml(language.label)}</option>`).join("");
applyStaticLanguage();

searchEl.addEventListener("input", () => renderTree(searchEl.value));
languageSelect.addEventListener("change", () => {
  currentLanguage = normalizeLanguage(languageSelect.value);
  window.localStorage.setItem(languageStorageKey, currentLanguage);
  applyStaticLanguage();
  loadPage();
});
window.addEventListener("hashchange", loadPage);
document.querySelector("#copy-install").addEventListener("click", async () => {
  const command = document.querySelector("#install-command").textContent;
  await navigator.clipboard?.writeText(command).catch(() => {});
  document.querySelector("#copy-install").textContent = translate("copied");
  setTimeout(() => {
    document.querySelector("#copy-install").textContent = translate("copy");
  }, 900);
});

renderTree();
loadPage();
