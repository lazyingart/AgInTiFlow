import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { deriveScsTaskContract } from "../src/scs-evidence.js";
import { nativeCapabilityPolicyContext, nativeWorkspaceToolGuidance } from "../src/native-tool-context.js";
import { preservedInputMutationBlock } from "../src/agent-runner.js";

for (const name of ["review.md", "café.md", "résumé.md", "週次レビュー.md", "검토.md", "δοκιμή.md", "cafe\u0301.md", "说明.md"]) {
  for (const quoted of [false, true]) test(`named text output preserves literal Unicode identity: ${JSON.stringify(name)}/${quoted}`, () => {
    const literal = `out/${name}`, goal = `Create ${quoted ? `\`${literal}\`` : literal} with a short welcome message. Only create that file.`;
    const c = deriveScsTaskContract({ goal });
    assert.deepEqual(c.exactOutputPaths, [literal]);
    assert.equal(c.requiresFileMutation, true);
    assert.deepEqual(c.exactInputPaths, []);
    assert.ok(c.requiredEvidence.some(e => e.category === "file"));
  });
}

for (const [goal, expected] of [
  ["Please create out/review.md with a short release-review checklist covering build, tests, and rollback. Only create that file.", "out/review.md"],
  ["Please create out/café.md with a short release-review checklist covering build, tests, and rollback. Only create that file.", "out/café.md"],
  ["Write out/guide.md with a guide about build, test workflows and deployment.", "out/guide.md"],
  ["Write out/guide.md explaining how to compile and publish software.", "out/guide.md"],
  ["Create out/guide.md describing how to run `npm test` and publish a package.", "out/guide.md"],
  ["Create out/guide.md with a checklist covering writing_specialist, generate_image and shell commands.", "out/guide.md"],
  ["创建 out/发布.md，内容涵盖构建、测试和部署。", "out/发布.md"],
  ["请写入 out/指南.md，內容包括安裝和編譯。", "out/指南.md"],
  ["out/手順.md を作成してください。本文には「テストしてください」という確認項目を入れてください。", "out/手順.md"],
  ["out/案内.md を作成してください。内容には「実行してください」という例文を含めてください。", "out/案内.md"],
]) test(`text artifact topics are content, not execution authority: ${goal}`, () => {
  const c = deriveScsTaskContract({ goal });
  assert.deepEqual(c.exactOutputPaths, [expected]);
  assert.ok(c.requiredEvidence.some(e => e.category === "file"));
  assert.equal(c.requiredEvidence.some(e => ["command", "test", "publish", "browser", "git"].includes(e.category)), false);
  assert.deepEqual(c.requiredProjectCommands, []);
  assert.deepEqual(c.requiredGitActions, []);
  assert.deepEqual(c.requiredToolCalls, []);
  assert.equal(c.requiresFileMutation, true);
  assert.ok(c.outcome.includes(expected), "the actual user task and content topic remain in the contract");
});

for (const goal of [
  "Create out/guide.md with a checklist covering build and tests. Then run `node --version`.",
  "Create out/guide.md with a checklist covering build, and actually run `node --version`.",
  "Write out/guide.md explaining how to compile. Also run `node --version`.",
  "Write out/guide.md explaining how to compile and then run `node --version`.",
  "Write out/guide.md describing how to build; run `node --version` too.",
  "Run `node --version`, then create out/guide.md with a checklist covering build and tests.",
  "创建 out/发布.md，内容涵盖构建和测试。然后运行 `node --version`。",
  "out/手順.md を作成してください。内容はテスト手順です。その後 `node --version` を実行してください。",
]) test(`independent execution after content remains mandatory: ${goal}`, () => {
  const c = deriveScsTaskContract({ goal });
  assert.ok(c.requiredEvidence.some(e => e.category === "command"));
  // These two existing grammar forms currently retain generic command evidence
  // but no exact literal-command identity. Topic masking must not waive that
  // guard; extending literal inference is a separate capability.
  if (!goal.includes("and actually") && !goal.includes("その後")) assert.ok(c.requiredProjectCommands.includes("node --version"));
});

for (const goal of [
  "Explain why builds fail. No file changes.",
  'Explain the sentence "Create out/café.md with a checklist covering build and tests". No file changes.',
  "Do not create out/café.md. Answer here only.",
  "Describe how to write a note about build systems here in chat. No files.",
]) test(`topic recognition never manufactures a file request: ${goal}`, () => {
  const c = deriveScsTaskContract({ goal });
  assert.deepEqual(c.exactOutputPaths, []);
  assert.equal(c.requiresFileMutation, false);
});

for (const [read, write, expectedRead, expectedWrite] of [
  [["out"], ["out"], ["out"], ["out"]],
  [["out"], [], ["out"], ["out"]],
  [["out"], ["out/review"], ["out"], ["out/review"]],
  [["inputs"], ["out"], ["inputs"], []],
  [["out", "入力"], ["入力"], ["out", "入力"], ["入力"]],
  [["."], ["out"], ["."], ["out"]],
]) test(`model scope summary matches the actual read/write intersection: ${JSON.stringify([read, write])}`, () => {
  const config = { commandCwd: "/owned-workspace", allowFileTools: true, allowShellTool: false, workspacePathScopeRoots: read, workspaceWritePathScopeRoots: write };
  const before = JSON.stringify(config), context = nativeCapabilityPolicyContext(config);
  assert.ok(context.includes(`Workspace structured-read roots: ${JSON.stringify(expectedRead)}`));
  assert.ok(context.includes(`Workspace structured-write roots: ${JSON.stringify(expectedWrite)}`));
  if (!expectedWrite.length) assert.match(context, /no admitted workspace paths/);
  assert.match(context, /read-root.*cannot expand|cannot expand.*read-root/);
  assert.equal(JSON.stringify(config), before);
  assert.match(nativeWorkspaceToolGuidance(config), /scope|exact target/);
});

for (const attack of ["proxy", "accessor", "sparse", "extra", "null", "string"]) test(`invalid scopes cannot become a broader model hint: ${attack}`, () => {
  let traps = 0, roots = ["out"];
  if (attack === "proxy") roots = new Proxy(roots, { get() { traps++; throw Error("get"); }, ownKeys() { traps++; throw Error("keys"); }, getPrototypeOf() { traps++; throw Error("prototype"); } });
  if (attack === "accessor") Object.defineProperty(roots, "0", { enumerable: true, get() { traps++; throw Error("accessor"); } });
  if (attack === "sparse") roots = Array(1);
  if (attack === "extra") roots.extra = "widen";
  if (attack === "null") roots = null;
  if (attack === "string") roots = "out";
  assert.throws(() => nativeCapabilityPolicyContext({ commandCwd: "/owned-workspace", allowFileTools: true, workspacePathScopeRoots: roots }), { code: "WORKSPACE_SCOPE_POLICY_INVALID" });
  assert.equal(traps, 0);
});

for (const name of ["café.md", "週次レビュー.md", "검토.md", "cafe\u0301.md"]) test(`Unicode file identity remains distinct in source/preservation/exclusion/creation roles: ${name}`, () => {
  const source = `input/${name}`, target = `out/${name}`;
  const read = deriveScsTaskContract({ goal: `Read ${source} and create ${target}.` });
  assert.deepEqual(read.exactInputPaths, [source]); assert.deepEqual(read.exactOutputPaths, [target]);
  const protectedFile = deriveScsTaskContract({ goal: `Create ${target} from ${source}. Do not modify ${source}.` });
  assert.deepEqual(protectedFile.preservedInputPaths, [source]); assert.deepEqual(protectedFile.exactOutputPaths, [target]);
  const excluded = deriveScsTaskContract({ goal: `Create out/other.md. Do not create ${target}.` });
  assert.deepEqual(excluded.exactOutputPaths, ["out/other.md"]); assert.ok(excluded.excludedOutputPaths.includes(target));
  const make = deriveScsTaskContract({ goal: `Make ${target} with a welcome message.` });
  assert.deepEqual(make.exactOutputPaths, [target]); assert.equal(make.requiresFileMutation, true);
});

test("oversized but valid scope lists omit display without suggesting unscoped access", () => {
  const roots = Array.from({ length: 32 }, (_, i) => `out/${i}/` + "x".repeat(300));
  const text = nativeCapabilityPolicyContext({ commandCwd: "/workspace-root", workspacePathScopeRoots: roots });
  assert.match(text, /exceed the prompt display limit/); assert.match(text, /runtime scope checks remain authoritative/);
  assert.doesNotMatch(text, /no additional root restriction/); assert.ok(text.length < 2500);
});

test("scoped-artifact roots intersect rather than widen the model write hint", () => {
  const text = nativeCapabilityPolicyContext({ commandCwd: "/workspace-root", workspacePathScopeRoots: ["out"], workspaceWritePathScopeRoots: ["out"], scopedArtifactTask: true, scopedArtifactRoot: "out/packet" });
  assert.match(text, /Workspace structured-write roots: \["out\/packet"\]/);
});

test("literal text filenames are not command-execution predicates", () => {
  for (const name of ["build.md", "compile.md", "npm.md", "node.md", "python.md", "run.md", "安装.md", "実行してください.md"]) {
    const c = deriveScsTaskContract({ goal: `Create out/${name} with a welcome message.` });
    assert.deepEqual(c.exactOutputPaths, [`out/${name}`]);
    assert.deepEqual(c.requiredEvidence.map(e => e.category), ["file"], name);
  }
});

test("literal-path masking keeps independent commands and executable inputs required", () => {
  for (const goal of ["Create out/build.md, then run `node --version`.", "Run `python tools/build.py` and create out/build.md."]) {
    const c = deriveScsTaskContract({ goal });
    assert.ok(c.requiredEvidence.some(e => e.category === "command")); assert.ok(c.requiredProjectCommands.length > 0);
  }
});

test("unspaced coordinated file names keep every preservation target and its mutation guard", () => {
  for (const [body, expected] of [
    ["a.csvとb.csv", ["a.csv", "b.csv"]],
    ["café.csvとrésumé.csv", ["café.csv", "résumé.csv"]],
    ['"café.csv"とrésumé.csv', ["café.csv", "résumé.csv"]],
    ['café.csvと"résumé.csv"', ["café.csv", "résumé.csv"]],
    ['"café.csv"と"résumé.csv"', ["café.csv", "résumé.csv"]],
    ["A.CSVとB.CSV", ["A.CSV", "B.CSV"]],
    ["a.abcdefghijklmnopqrstuvwxyzとb.longextension", ["a.abcdefghijklmnopqrstuvwxyz", "b.longextension"]],
    ["a.拡張とb.拡張", ["a.拡張", "b.拡張"]],
    ["a.csvおよびb.csv", ["a.csv", "b.csv"]],
    ["a.csv及びb.csv", ["a.csv", "b.csv"]],
    ["a.csv和b.csv", ["a.csv", "b.csv"]],
    ["LICENSEとNOTICE", ["LICENSE", "NOTICE"]],
  ]) {
    const goal = `${body}は変更しないでください。out/review.mdを作成してください。`;
    const c = deriveScsTaskContract({ goal }); assert.deepEqual(c.preservedInputPaths, expected, body);
    for (const path of expected) assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path, content: "bad" }, { goal })?.category, "preserved-input-mutation", body + ":" + path);
  }
});

test("coordinating words within a literal basename remain one path", () => {
  for (const [body, expected] of [['"a.csvとb.csv"', "a.csvとb.csv"], ["out/週次と月次.md", "out/週次と月次.md"], ['"one and two.md"', "one and two.md"]]) {
    const goal = `${body}は変更しないでください。out/review.mdを作成してください。`;
    assert.deepEqual(deriveScsTaskContract({ goal }).preservedInputPaths, [expected]);
    assert.equal(preservedInputMutationBlock({ goal }, "write_file", { path: expected, content: "bad" }, { goal })?.category, "preserved-input-mutation");
  }
});

test("dense valid and malformed Unicode lists finish within a bounded child watchdog", () => {
  const code = `import assert from 'node:assert/strict'; import {deriveScsTaskContract as d} from ${JSON.stringify(new URL("../src/scs-evidence.js", import.meta.url).href)};
    const list=Array.from({length:16},(_,i)=>'f'+i+'.csv').join('と');
    assert.equal(d({goal:list+'は変更しないでください。out/review.mdを作成してください。'}).preservedInputPaths.length,16);
    const mixed=Array.from({length:16},(_,i)=>i%2?'"f'+i+'.csv"':'f'+i+'.csv').join('と');
    assert.equal(d({goal:mixed+'は変更しないでください。out/review.mdを作成してください。'}).preservedInputPaths.length,16);
    for(const suffix of ['は変更しない謎です。','は変更しない謎です。out/review.mdを作成してください。']) assert.deepEqual(d({goal:list+suffix}).preservedInputPaths,[]);
    console.log('bounded-list-ok');`;
  assert.match(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000, maxBuffer: 65536, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } }), /bounded-list-ok/);
});
