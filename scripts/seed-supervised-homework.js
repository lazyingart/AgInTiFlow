#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const defaultRoot = "/home/lachlan/ProjectsLFS/Aginti-Test";
const root = path.resolve(process.env.AGINTI_TEST_ROOT || defaultRoot);

const TASKS = [
  ["Auto", "auto", "Infer a messy sensor-analysis folder, clean it, write a useful report, run checks, and commit only intentional work."],
  ["Code", "code", "Repair a small package from vague bug reports, add focused tests, clean generated artifacts, and commit the fix."],
  ["Large-Codebase", "large-codebase", "Fix a cross-package bug in a multi-package repo with failing tests, using project orientation before edits."],
  ["QA", "qa", "Build or repair a realistic testing project, reproduce any real failures found, add useful regression coverage, and show focused then broad checks."],
  ["Database", "database", "Fix a SQLite schema/query/migration bug without data loss and verify with local fixtures."],
  ["DevOps", "devops", "Diagnose a broken container/service setup without sudo, make it idempotent, and prove health/log output."],
  ["Security", "security", "Review and patch a tiny app for path traversal, secret leakage, command injection, and weak auth defaults."],
  ["Data", "data", "Clean messy CSV/JSON data, preserve raw inputs, produce validated outputs, plots, and a report."],
  ["Docs", "docs", "Turn a rough project into source-backed README, API reference, tutorial, troubleshooting, and verified commands."],
  ["Design", "design", "Write a product and engineering design doc with options, tradeoffs, risks, rollout, and verification criteria."],
  ["Website", "website", "Build a polished responsive landing page from a vague product idea, preview it, and save screenshot evidence."],
  ["App", "app", "Build a small usable local app with real functions, tests or smoke checks, preview/install evidence, and a clean commit."],
  ["Android", "android", "Build, test, install, launch, and screenshot an Android app when SDK/emulator tooling exists; otherwise produce exact blocker evidence."],
  ["IOS", "ios", "Build or scaffold a SwiftUI/SwiftPM app, inspect Xcode/simulator availability, run available tests, and save artifacts or blocker evidence."],
  ["Java", "java", "Repair a Java/Kotlin JVM Maven or Gradle project, run compile/tests, and avoid global JDK/toolchain mutation."],
  ["Node", "node", "Build and test a Node/TypeScript package or app, respecting package manager scripts and lockfile discipline."],
  ["Python", "python", "Create or repair a Python package/CLI/analysis workflow with tests, cache hygiene, and durable output files."],
  ["Go", "go", "Fix a Go module with CLI/server behavior, run gofmt and focused go tests, and report missing Go blockers precisely."],
  ["Rust", "rust", "Fix a Cargo crate/workspace, run fmt/check/test where available, and avoid unnecessary dependency churn."],
  ["Dotnet", "dotnet", "Repair a .NET/C# app or library, run restore/build/test where available, and keep bin/obj out of commits."],
  ["PHP", "php", "Fix a PHP Composer/Laravel-style project, run php lint/tests, and keep vendor/global extension changes out of commits."],
  ["Ruby", "ruby", "Fix a Ruby/Rails/gem project, run bundle/rake/rspec evidence when available, and keep generated artifacts ignored."],
  ["C-Cpp", "c-cpp", "Fix a C/C++ CMake or Make project with compiler/test evidence and no source-unrelated build artifacts committed."],
  ["R-Stan", "r-stan", "Run a reproducible R/Stan/statistical analysis with seed handling, script output, and saved report/plot artifacts."],
  ["Latex", "latex", "Write and compile a LaTeX report or paper with figure, bibliography if needed, and durable PDF/source paths."],
  ["Paper", "paper", "Draft a research-style manuscript with claims, figure, source notes, and compile/export evidence when possible."],
  ["Research", "research", "Research a current technical question, save dated source-backed notes, and separate evidence from inference."],
  ["Writing", "writing", "Turn rough notes into a polished article/script with outline, draft, revision notes, and preserved voice."],
  ["Book", "book", "Create a book plan, chapter map, one drafted chapter, style notes, and a revision checklist."],
  ["Novel", "novel", "Create a fiction premise, character/continuity bible, one scene/chapter draft, and revision notes."],
  ["Slides", "slides", "Create a deck or poster source with speaker notes, concise slide structure, and preview/export evidence when possible."],
  ["Education", "education", "Create a lesson module with objectives, examples, exercises, answer key, and checked code/math examples."],
  ["Image", "image", "Generate or prepare an image asset with prompt manifest, durable file path, and canvas/preview evidence when keys exist."],
  ["Word", "word", "Create or convert a Word-style document while preserving originals and verifying the output exists."],
  ["Github", "github", "Use a local remote to practice safe status/diff, fast-forward pull, conflict stop, commit, push, and gh-style notes."],
  ["Shell", "shell", "Write an idempotent diagnostic/setup shell script with read-only evidence first, syntax checks, and rollback notes."],
  ["Maintenance", "maintenance", "Diagnose a broken local toolchain/environment without sudo, write reversible setup notes/scripts, and show evidence."],
  ["AAPS", "aaps", "Inspect AAPS-style project conventions, create or update automation files safely, and document assumptions without secrets."],
  ["Supervision", "supervision", "Supervise a smaller student agent/session, verify artifacts independently, and record reusable AgInTiFlow improvements."],
];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(filePath, content) {
  if (await exists(filePath)) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

function taskMarkdown(folderName, profile, brief) {
  return `# ${profile} Profile Homework

## Student Prompt

This folder is a supervised AgInTiFlow homework workspace. Start AgInTiFlow here with profile \`${profile}\` unless the supervisor intentionally tests \`auto\`.

Normal user-level prompt:

> This project is messy and incomplete. Please inspect it, figure out what is wrong, finish it properly, verify the result, and commit the intentional work.

## Challenge

${brief}

## Acceptance Criteria

- Run \`/init\` or create/update \`AGINTI.md\` with project-specific instructions.
- Inspect before editing: project tree, manifests, tests, docs, and current git status.
- Produce durable outputs in this workspace using descriptive filenames.
- Run the most relevant focused checks, then broader checks when useful.
- Do not rely only on chat summaries; verify files, commands, screenshots, PDFs, reports, or app launches as appropriate.
- Initialize git if needed and commit intentional work only after checks.
- Leave generated caches, sessions, build output, and temporary files ignored or cleaned.
- Record any real external blocker with exact evidence instead of pretending success.

## Supervisor Evidence To Collect

- tmux session name and AgInTi session id.
- \`git status --short\`, \`git log --oneline -3\`, and key diff/stat.
- Domain-specific checks and output paths.
- A short postmortem: what AgInTi did alone, what it missed, and what reusable AgInTiFlow improvement was added.

## Folder

\`${folderName}\`
`;
}

async function seedTaskFolders() {
  await fs.mkdir(root, { recursive: true });
  await writeIfMissing(
    path.join(root, "README.md"),
    `# AgInTiFlow Supervised Homework

This workspace contains one supervised homework project per AgInTiFlow task profile. Empty folders mean "not yet run"; a completed folder must contain real outputs, verification evidence, and usually a git commit.

Run \`node scripts/seed-supervised-homework.js\` from the AgInTiFlow repo to create missing task briefs.
`
  );

  for (const [folderSuffix, profile, brief] of TASKS) {
    const folderName = `TASK-Profile-${folderSuffix}`;
    const folder = path.join(root, folderName);
    await fs.mkdir(folder, { recursive: true });
    await writeIfMissing(path.join(folder, "TASK.md"), taskMarkdown(folderName, profile, brief));
    await writeIfMissing(
      path.join(folder, ".gitignore"),
      `.aginti/
.sessions/
node_modules/
vendor/
.pytest_cache/
__pycache__/
*.pyc
build/
dist/
target/
bin/
obj/
.gradle/
.DS_Store
`
    );
  }
}

async function seedLargeCodebaseFixture() {
  const folder = path.join(root, "TASK-Profile-Large-Codebase");
  await fs.mkdir(folder, { recursive: true });

  await writeIfMissing(
    path.join(folder, "package.json"),
    `{
  "name": "checkout-workspace",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test \\"packages/**/*.test.js\\"",
    "check": "node --check packages/catalog/src/catalog.js && node --check packages/cart/src/cart.js && node --check packages/report/src/report.js"
  }
}
`
  );
  await writeIfMissing(
    path.join(folder, "README.md"),
    `# Checkout Workspace

A deliberately small multi-package checkout repo for supervised large-codebase training.

The report and pricing behavior are wrong across package boundaries. The student agent should inspect the codebase, run tests, repair the root causes, add or update tests if useful, and commit the finished work.
`
  );
  await writeIfMissing(
    path.join(folder, "AGINTI.md"),
    `# Project Instructions

- Use \`npm test\` and \`npm run check\` for verification.
- Keep fixes source-focused; do not commit \`.aginti/\`, \`.sessions/\`, or generated caches.
- This is a supervised homework fixture. Do not read external solutions.
`
  );
  await writeIfMissing(path.join(folder, "packages/catalog/package.json"), `{"name":"@checkout/catalog","type":"module","private":true}\n`);
  await writeIfMissing(path.join(folder, "packages/cart/package.json"), `{"name":"@checkout/cart","type":"module","private":true}\n`);
  await writeIfMissing(path.join(folder, "packages/report/package.json"), `{"name":"@checkout/report","type":"module","private":true}\n`);
  await writeIfMissing(
    path.join(folder, "packages/catalog/src/catalog.js"),
    `export const PRODUCTS = [
  { sku: "tea-sampler", name: "Tea Sampler", priceCents: 1600 },
  { sku: "ceramic-mug", name: "Ceramic Mug", priceCents: 2000 },
  { sku: "desk-plant", name: "Desk Plant", priceCents: 2450 },
];

export function normalizeSku(sku) {
  return String(sku || "").trim().toLowerCase().replace(/_/g, "-");
}

export function findProduct(sku) {
  const normalized = normalizeSku(sku);
  return PRODUCTS.find((product) => product.sku === normalized) || null;
}
`
  );
  await writeIfMissing(
    path.join(folder, "packages/catalog/catalog.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { findProduct, normalizeSku } from "./src/catalog.js";

test("normalizes human-entered SKUs consistently", () => {
  assert.equal(normalizeSku(" Tea Sampler "), "tea-sampler");
  assert.equal(normalizeSku("CERAMIC_MUG"), "ceramic-mug");
});

test("findProduct accepts common operator input variants", () => {
  assert.equal(findProduct("tea sampler").name, "Tea Sampler");
  assert.equal(findProduct("CERAMIC_MUG").priceCents, 2000);
});
`
  );
  await writeIfMissing(
    path.join(folder, "packages/cart/src/cart.js"),
    `import { findProduct } from "../../catalog/src/catalog.js";

export function priceCart(items, coupon = null) {
  const pricedItems = [];
  let subtotalCents = 0;
  let discountCents = 0;

  for (const item of items) {
    const product = findProduct(item.sku);
    if (!product) throw new Error(\`Unknown SKU: \${item.sku}\`);
    const quantity = Number(item.quantity || item.qty || 1);
    const lineCents = product.priceCents * quantity;
    subtotalCents += lineCents;
    if (coupon?.percent) {
      discountCents += Math.round(product.priceCents * (coupon.percent / 100));
    }
    pricedItems.push({ sku: product.sku, name: product.name, quantity, lineCents });
  }

  const shippingCents = subtotalCents - discountCents >= 5000 ? 0 : 699;
  const totalCents = subtotalCents - discountCents + shippingCents;
  return { items: pricedItems, subtotalCents, discountCents, shippingCents, totalCents };
}
`
  );
  await writeIfMissing(
    path.join(folder, "packages/cart/cart.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { priceCart } from "./src/cart.js";

test("prices quantities and applies percentage discount to the full subtotal", () => {
  const result = priceCart(
    [
      { sku: "tea sampler", quantity: 2 },
      { sku: "ceramic_mug", quantity: 1 },
    ],
    { code: "SPRING10", percent: 10 }
  );

  assert.equal(result.subtotalCents, 5200);
  assert.equal(result.discountCents, 520);
  assert.equal(result.shippingCents, 699);
  assert.equal(result.totalCents, 5379);
});
`
  );
  await writeIfMissing(
    path.join(folder, "packages/report/src/report.js"),
    `import { priceCart } from "../../cart/src/cart.js";

export function formatMoney(cents) {
  return "$" + (cents / 100).toFixed(2);
}

export function buildCheckoutReport(order) {
  const priced = priceCart(order.items, order.coupon);
  return {
    orderId: order.id,
    totalItems: priced.items.length,
    subtotal: formatMoney(priced.subtotalCents),
    discount: formatMoney(priced.discountCents),
    shipping: formatMoney(priced.shippingCents),
    total: formatMoney(priced.totalCents),
  };
}
`
  );
  await writeIfMissing(
    path.join(folder, "packages/report/report.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckoutReport } from "./src/report.js";

test("reports total item quantity and checkout totals", () => {
  const report = buildCheckoutReport({
    id: "ORD-42",
    coupon: { code: "SPRING10", percent: 10 },
    items: [
      { sku: "tea sampler", quantity: 2 },
      { sku: "ceramic_mug", quantity: 1 },
    ],
  });

  assert.deepEqual(report, {
    orderId: "ORD-42",
    totalItems: 3,
    subtotal: "$52.00",
    discount: "$5.20",
    shipping: "$6.99",
    total: "$53.79",
  });
});
`
  );
}

await seedTaskFolders();
await seedLargeCodebaseFixture();

console.log(
  JSON.stringify(
    {
      ok: true,
      root,
      taskFolders: TASKS.length,
      seededLargeCodebase: path.join(root, "TASK-Profile-Large-Codebase"),
    },
    null,
    2
  )
);
