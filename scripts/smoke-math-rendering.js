#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-math-smoke-"));
const port = 48000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(port), "--host", "127.0.0.1"],
  {
    cwd: runtimeDir,
    env: {
      ...process.env,
      AGINTIFLOW_HOME: path.join(runtimeDir, ".agintiflow-home"),
      AGINTIFLOW_RUNTIME_DIR: runtimeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let stdout = "";
let stderr = "";
let browser;
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && (await response.json()).ok) return;
    } catch {
      // The local server may still be binding its port.
    }
    await delay(200);
  }
  throw new Error(`math smoke server did not become healthy. stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
}

async function assertTextAsset(assetPath, contentType, expectedText) {
  const response = await fetch(`${baseUrl}${assetPath}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`${assetPath} returned ${response.status}`);
  if (!response.headers.get("content-type")?.includes(contentType)) {
    throw new Error(`${assetPath} has unexpected content type ${response.headers.get("content-type") || "missing"}`);
  }
  if (!body.includes(expectedText)) throw new Error(`${assetPath} did not contain ${expectedText}`);
  if (/https?:\/\/(?:cdn|unpkg|jsdelivr)\./i.test(body)) throw new Error(`${assetPath} references a public CDN`);
}

try {
  await waitForHealth();
  await assertTextAsset("/vendor/katex/katex.mjs", "javascript", "renderToString");
  await assertTextAsset("/vendor/katex/katex.min.css", "text/css", "KaTeX_Main");
  await assertTextAsset("/math-renderer.js", "javascript", 'trust: false');
  await assertTextAsset("/markdown-renderer.js", "javascript", "replaceInlineMath");

  const fontResponse = await fetch(`${baseUrl}/vendor/katex/fonts/KaTeX_Main-Regular.woff2`);
  const fontBytes = await fontResponse.arrayBuffer();
  if (!fontResponse.ok || fontBytes.byteLength < 1000) throw new Error("bundled KaTeX font asset is unavailable");
  if (fontResponse.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("KaTeX assets are missing nosniff protection");
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== baseUrl) externalRequests.push(request.url());
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#chat-input");

  const result = await page.evaluate(async () => {
    const { renderMarkdown } = await import("/markdown-renderer.js");
    window.__agintiMathXss = 0;
    const fixture = [
      "# Physics notes",
      "",
      "Inline $E=mc^2$ and \\(a^2+b^2=c^2\\).",
      "",
      "- Safe unordered item",
      "- Formula item $x^2$",
      "",
      "1. First ordered item",
      "2. Second ordered item",
      "",
      "> Quoted evidence with \\(q=1\\).",
      "",
      "[Local documentation](/docs/local-first-agent-runtime.md)",
      "",
      "| Name | Formula |",
      "| --- | --- |",
      "| Energy | $E=mc^2$ |",
      "",
      "$$",
      "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      "$$",
      "",
      "\\[",
      "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
      "\\]",
      "",
      "Inline code: `$not_math$`.",
      "",
      "```tex",
      "$$not_math$$",
      "<img src=x onerror=window.__agintiMathXss=1>",
      "```",
      "",
      '<img src=x onerror="window.__agintiMathXss=1">',
      "$\\href{javascript:window.__agintiMathXss=1}{unsafe}$",
      "Malformed $\\frac{1$ remains readable.",
    ].join("\n");
    const host = document.createElement("section");
    host.id = "math-smoke-fixture";
    host.className = "markdown-body";
    host.innerHTML = renderMarkdown(fixture);
    document.body.append(host);
    await document.fonts.ready;

    return {
      inlineMath: host.querySelectorAll('[data-math-rendered="inline"] .katex').length,
      displayMath: host.querySelectorAll('[data-math-rendered="display"] .katex').length,
      accessibleMathMl: host.querySelectorAll(".katex-mathml math").length,
      displayBlocks: [...host.querySelectorAll('[data-math-rendered="display"]')].map((node) => node.tagName),
      fencedText: host.querySelector("pre code")?.textContent || "",
      fencedMath: host.querySelectorAll("pre code .katex").length,
      inlineCode: [...host.querySelectorAll("p > code")].map((node) => node.textContent),
      malformedFallback: [...host.querySelectorAll('[data-math-fallback="true"]')].map((node) => node.textContent),
      unsafeElements: host.querySelectorAll('script, img, [onerror], a[href^="javascript:"]').length,
      xssValue: window.__agintiMathXss,
      mathRoles: host.querySelectorAll('[role="math"]').length,
      heading: host.querySelector("h1")?.textContent || "",
      unorderedItems: host.querySelectorAll("ul > li").length,
      orderedItems: host.querySelectorAll("ol > li").length,
      quote: host.querySelector("blockquote")?.textContent || "",
      relativeLink: host.querySelector('a[href$="/docs/local-first-agent-runtime.md"]')?.getAttribute("href") || "",
      tableCells: host.querySelectorAll("table td").length,
      tableMath: host.querySelectorAll("table .katex").length,
    };
  });

  if (result.inlineMath < 2) throw new Error(`expected both inline delimiter forms, found ${result.inlineMath}`);
  if (result.displayMath !== 2 || result.displayBlocks.some((tag) => tag !== "DIV")) {
    throw new Error(`display math did not render as two standalone blocks: ${JSON.stringify(result.displayBlocks)}`);
  }
  if (result.accessibleMathMl < 4 || result.mathRoles < 4) {
    throw new Error("rendered expressions are missing accessible MathML or math roles");
  }
  if (result.fencedMath !== 0 || !result.fencedText.includes("$$not_math$$") || !result.fencedText.includes("<img")) {
    throw new Error("fenced code was not preserved verbatim");
  }
  if (!result.inlineCode.includes("$not_math$")) throw new Error("inline code was not preserved verbatim");
  if (!result.malformedFallback.includes("$\\frac{1$")) throw new Error("malformed TeX did not fall back to readable source");
  if (result.unsafeElements !== 0 || result.xssValue !== 0) {
    throw new Error("untrusted Markdown or TeX produced executable HTML");
  }
  if (
    result.heading !== "Physics notes" ||
    result.unorderedItems !== 2 ||
    result.orderedItems !== 2 ||
    !result.quote.includes("Quoted evidence") ||
    !result.relativeLink.endsWith("/docs/local-first-agent-runtime.md") ||
    result.tableCells !== 2 ||
    result.tableMath !== 1
  ) {
    throw new Error(`Markdown structure or table math did not render correctly: ${JSON.stringify(result)}`);
  }
  if (externalRequests.length) throw new Error(`math rendering made external requests: ${externalRequests.join(", ")}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "offline-katex-module-css-fonts",
          "inline-dollar-and-parenthesis-math",
          "display-dollar-and-bracket-math",
          "accessible-mathml",
          "inline-and-fenced-code-verbatim",
          "malformed-tex-fallback",
          "markdown-and-tex-xss-blocked",
          "headings-lists-quotes-links-and-table-math",
          "zero-cdn-requests",
        ],
      },
      null,
      2
    )
  );
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await delay(150);
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
