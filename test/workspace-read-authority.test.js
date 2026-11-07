import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { executeWorkspaceTool } from "../src/workspace-tools.js";
import { readImage } from "../src/perception-tools.js";
import { normalizeCanvasPayload, persistCanvasPayloadFile, resolveArtifactFile, readArtifactContent } from "../src/artifact-tunnel.js";
import { isWorkspaceReadScopeDenial, workspaceReadBoundaryError } from "../src/workspace-read-boundary.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const authorized = "Authorized text: green orchard.\n";
const excluded = "Synthetic excluded text: violet lighthouse.\n";
test("only native scope errors carry policy authority, without consulting caller hooks", () => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error("get"); }, getPrototypeOf() { traps++; throw Error("prototype"); }, ownKeys() { traps++; throw Error("keys"); } });
  const accessor = Object.defineProperty({}, "code", { get() { traps++; throw Error("code"); } });
  for (const value of [proxy, accessor, null, undefined, "WORKSPACE_READ_SCOPE", { code: "WORKSPACE_READ_SCOPE" },
    Object.assign(Error("forged"), { code: "WORKSPACE_READ_SCOPE" }), workspaceReadBoundaryError(true)]) assert.equal(isWorkspaceReadScopeDenial(value), false);
  assert.equal(isWorkspaceReadScopeDenial(workspaceReadBoundaryError()), true); assert.equal(traps, 0);
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-read-authority-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), other = path.join(root, "not-admitted");
  await fs.mkdir(workspace); await fs.mkdir(other);
  await fs.writeFile(path.join(workspace, "source.txt"), authorized);
  await fs.writeFile(path.join(other, "record.txt"), excluded);
  const config = { commandCwd: workspace, baseDir: workspace, allowFileTools: true, sandboxMode: "host",
    workspaceWritePolicy: "allow", readOnlyRoots: [], allowDestructive: false };
  return { root, workspace, other, config };
}
const read = (config, name, args = {}) => executeWorkspaceTool("read_file", { path: name, ...args }, config);
function replace(t, object, name, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { ...descriptor, value: wrap(descriptor.value) });
  t.after(() => Object.defineProperty(object, name, descriptor));
}

for (const kind of ["file", "directory", "chain"]) test("outside " + kind + " aliases cannot grant read authority", async t => {
  const { workspace, other, config } = await fixture(t);
  if (kind === "directory") await fs.symlink(other, path.join(workspace, "linked"));
  else {
    await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "linked.txt"));
    if (kind === "chain") await fs.symlink("linked.txt", path.join(workspace, "chain.txt"));
  }
  const name = kind === "directory" ? "linked/record.txt" : kind === "chain" ? "chain.txt" : "linked.txt";
  await assert.rejects(read(config, name), error => error.code === "WORKSPACE_READ_SCOPE" && !error.message.includes(other));
});

for (const name of [".env", ".env.local", ".git/config", "credentials/note.txt", "private.key"]) {
  test("an innocent alias cannot hide blocked target " + name, async t => {
    const { workspace, config } = await fixture(t);
    await fs.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await fs.writeFile(path.join(workspace, name), excluded);
    await fs.symlink(path.join(workspace, name), path.join(workspace, "visible.txt"));
    await assert.rejects(read(config, "visible.txt"), { code: "WORKSPACE_READ_SCOPE" });
  });
}

for (const kind of ["file", "directory", "root"]) test("ordinary authorized " + kind + " aliases remain usable", async t => {
  const { root, workspace, config } = await fixture(t);
  let name = "source.txt";
  if (kind === "file") { await fs.symlink("source.txt", path.join(workspace, "inside.txt")); name = "inside.txt"; }
  if (kind === "directory") { await fs.mkdir(path.join(workspace, "src")); await fs.rename(path.join(workspace, "source.txt"), path.join(workspace, "src/source.txt")); await fs.symlink("src", path.join(workspace, "linked")); name = "linked/source.txt"; }
  if (kind === "root") { await fs.symlink(workspace, path.join(root, "alias")); config.commandCwd = path.join(root, "alias"); }
  const result = await read(config, name);
  assert.equal(result.content, authorized); assert.equal(result.sha256, hash(authorized));
  assert.equal(result.bytes, Buffer.byteLength(authorized)); assert.equal(result.path, name);
});

test("an explicitly selected root name is not a blocked descendant path", async t => {
  const { root, workspace, config } = await fixture(t);
  const selected = path.join(root, "secrets"); await fs.rename(workspace, selected); config.commandCwd = selected;
  assert.equal((await read(config, "source.txt")).content, authorized);
  await fs.writeFile(path.join(selected, ".env"), excluded); await fs.symlink(".env", path.join(selected, "visible.txt"));
  await assert.rejects(read(config, "visible.txt"), { code: "WORKSPACE_READ_SCOPE" });
});

for (const field of ["readOnlyRoots", "skillReadOnlyRoots"]) test("explicit " + field + " authorizes the intended source only", async t => {
  const { workspace, other, config } = await fixture(t);
  config[field] = [other];
  await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "linked.txt"));
  assert.equal((await read(config, "linked.txt")).content, excluded);
  assert.equal((await read(config, path.join(other, "record.txt"))).content, excluded);
  await fs.writeFile(path.join(other, ".env"), excluded); await fs.symlink(path.join(other, ".env"), path.join(workspace, "visible.txt"));
  await assert.rejects(read(config, "visible.txt"), { code: "WORKSPACE_READ_SCOPE" });
});

test("missing optional roots do not disable an authorized workspace", async t => {
  const { root, config } = await fixture(t); config.readOnlyRoots = [path.join(root, "missing")];
  assert.equal((await read(config, "source.txt")).content, authorized);
});

test("an inaccessible optional root cannot disable ordinary reads or grant authority", async t => {
  const { workspace, other, config } = await fixture(t); config.readOnlyRoots = [other];
  await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "linked.txt"));
  replace(t, fs, "realpath", original => async (...args) => {
    if (args[0] === other) throw Object.assign(Error("Synthetic inaccessible optional root"), { code: "EACCES" });
    return Reflect.apply(original, fs, args);
  });
  assert.equal((await read(config, "source.txt")).content, authorized);
  await assert.rejects(read(config, "linked.txt"), { code: "WORKSPACE_READ_SCOPE" });
});

test("an unused optional root replacement cannot invalidate an unchanged workspace read", async t => {
  const { root, workspace, other, config } = await fixture(t); config.readOnlyRoots = [other];
  const file = path.join(workspace, "source.txt"); let injected = false;
  replace(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        if (!injected) { injected = true; await fs.rename(other, path.join(root, "prior-other")); await fs.mkdir(other); }
        return result;
      };
    }
    return handle;
  });
  assert.equal((await read(config, "source.txt")).content, authorized);
  assert.equal(injected, true);
});

test("empty optional roots cannot implicitly admit process.cwd", async t => {
  const { workspace, config } = await fixture(t); config.readOnlyRoots = ["", null];
  await fs.symlink(path.join(import.meta.dirname, "../package.json"), path.join(workspace, "linked.json"));
  await assert.rejects(read(config, "linked.json"), { code: "WORKSPACE_READ_SCOPE" });
});

test("an active path scope cannot be expanded by an alias or optional root", async t => {
  const { workspace, other, config } = await fixture(t);
  await fs.mkdir(path.join(workspace, "scope"));
  await fs.symlink(path.join(workspace, "source.txt"), path.join(workspace, "scope/outside.txt"));
  config.workspacePathScopeRoots = ["scope"]; config.readOnlyRoots = [other];
  await assert.rejects(read(config, "scope/outside.txt"), { code: "WORKSPACE_READ_SCOPE" });
  await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "scope/other.txt"));
  await assert.rejects(read(config, "scope/other.txt"), { code: "WORKSPACE_READ_SCOPE" });
});

test("a scope directory alias cannot authorize its own external target", async t => {
  const { workspace, other, config } = await fixture(t);
  await fs.symlink(other, path.join(workspace, "scope"));
  config.workspacePathScopeRoots = ["scope"]; config.readOnlyRoots = [other];
  await assert.rejects(read(config, "scope/record.txt"), { code: "WORKSPACE_READ_SCOPE" });
});

for (const tool of ["list_files", "search_files", "inspect_project"]) test(tool + " filters aliases to external and blocked trees", async t => {
  const { workspace, other, config } = await fixture(t);
  await fs.symlink(other, path.join(workspace, "linked"));
  await fs.writeFile(path.join(other, "package.json"), JSON.stringify({ scripts: { leak: excluded } }));
  await fs.symlink(path.join(other, "package.json"), path.join(workspace, "package.json"));
  await fs.mkdir(path.join(workspace, ".git")); await fs.writeFile(path.join(workspace, ".git/config"), excluded);
  await fs.symlink(path.join(workspace, ".git"), path.join(workspace, "visible"));
  const result = await executeWorkspaceTool(tool, { path: ".", query: "lighthouse", includeFiles: true }, config);
  const text = JSON.stringify(result);
  assert.equal(text.includes("violet lighthouse"), false); assert.equal(text.includes("record.txt"), false);
  assert.equal(text.includes("visible/config"), false);
  if (tool === "inspect_project") assert.deepEqual(result.packageScripts, []);
  await assert.rejects(executeWorkspaceTool(tool, { path: "linked", query: "lighthouse" }, config), { code: "WORKSPACE_READ_SCOPE" });
});

for (const kind of ["replace", "delete", "move"]) test("mutation preflight does not read through a source alias: " + kind, async t => {
  const { workspace, other, config } = await fixture(t);
  await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "source-link.txt"));
  const args = kind === "replace" ? { path: "source-link.txt", search: "violet", replace: "orange" }
    : { patch: "*** Begin Patch\n*** " + (kind === "delete" ? "Delete" : "Update") + " File: source-link.txt\n" +
      (kind === "move" ? "*** Move to: moved.txt\n@@\n-Synthetic excluded text: violet lighthouse.\n+Synthetic excluded text: violet lighthouse.\n" : "") + "*** End Patch" };
  await assert.rejects(executeWorkspaceTool("apply_patch", args, config), { code: "WORKSPACE_READ_SCOPE" });
  assert.equal(await fs.readFile(path.join(other, "record.txt"), "utf8"), excluded);
  await assert.rejects(fs.stat(path.join(workspace, "moved.txt")), { code: "ENOENT" });
});

for (const bytes of [Buffer.from([0xc3]), Buffer.from([0xff, 0x61]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xc0, 0xaf])]) {
  test("non-UTF-8 bytes are refused without replacement: " + bytes.toString("hex"), async t => {
    const { workspace, config } = await fixture(t); await fs.writeFile(path.join(workspace, "legacy.txt"), bytes);
    await assert.rejects(read(config, "legacy.txt"), /not valid UTF-8/);
    assert.deepEqual(await fs.readFile(path.join(workspace, "legacy.txt")), bytes);
  });
}

for (const content of ["中文 / 日本語 / café / 🌱\n", "\ufeffBOM is retained\n", "A real replacement character: \ufffd\n", ""]) {
  test("valid UTF-8 stays byte-faithful: " + JSON.stringify(content), async t => {
    const { workspace, config } = await fixture(t); await fs.writeFile(path.join(workspace, "text.txt"), content);
    const result = await read(config, "text.txt");
    assert.equal(result.content, content); assert.equal(result.sha256, hash(content)); assert.equal(result.bytes, Buffer.byteLength(content));
  });
}

test("bounded line reads still support a larger valid source", async t => {
  const { workspace, config } = await fixture(t); const content = "first\n" + "second 🌱\n".repeat(30000);
  await fs.writeFile(path.join(workspace, "large.txt"), content);
  await assert.rejects(read(config, "large.txt"), /too large/);
  const result = await read(config, "large.txt", { startLine: 2, lineLimit: 1 });
  assert.equal(result.content, "second 🌱"); assert.equal(result.sha256, hash(content)); assert.equal(result.contentTruncatedByLines, true);
});

test("a read that grows after fstat is rejected before returning a hash or body", async t => {
  const { workspace, config } = await fixture(t); const file = path.join(workspace, "source.txt"); let injected = false, bytesRead = 0;
  replace(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === file) {
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
      handle.stat = async (...args) => {
        const result = await stat(...args);
        if (!injected) { injected = true; await fs.appendFile(file, "x".repeat(230000)); }
        return result;
      };
      handle.read = async (...args) => { const result = await read(...args); bytesRead += result.bytesRead; return result; };
    }
    return handle;
  });
  await assert.rejects(read(config, "source.txt"), { code: "WORKSPACE_READ_CHANGED" });
  assert.equal(injected, true); assert.ok(bytesRead <= Buffer.byteLength(authorized) + 1);
});

test("retargeting an alias after an admitted read cannot return late content", async t => {
  const { workspace, other, config } = await fixture(t); const file = path.join(workspace, "source.txt"), link = path.join(workspace, "inside.txt");
  await fs.symlink(file, link); let injected = false;
  replace(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        if (!injected) { injected = true; await fs.unlink(link); await fs.symlink(path.join(other, "record.txt"), link); }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(read(config, "inside.txt"), error => ["WORKSPACE_READ_SCOPE", "WORKSPACE_READ_CHANGED"].includes(error.code));
  assert.equal(injected, true);
});

test("replacing the named workspace rejects the current observation, not a later fresh tool", async t => {
  const { root, workspace, config } = await fixture(t); const file = path.join(workspace, "source.txt"); let injected = false;
  replace(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        if (!injected) { injected = true; await fs.rename(workspace, path.join(root, "prior")); await fs.mkdir(workspace); await fs.writeFile(file, "New workspace.\n"); }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(read(config, "source.txt"), { code: "WORKSPACE_READ_CHANGED" });
  assert.equal(injected, true);
  assert.equal((await read(config, "source.txt")).content, "New workspace.\n");
});

test("close failure is surfaced once and cannot return a successful read", async t => {
  const { workspace, config } = await fixture(t); const file = path.join(workspace, "source.txt");
  let opened, closes = 0;
  replace(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === file) {
      opened = handle; const close = handle.close.bind(handle);
      handle.close = async () => { closes++; await close(); throw Object.assign(Error("Synthetic closed-handle failure"), { code: "EIO" }); };
    }
    return handle;
  });
  await assert.rejects(read(config, "source.txt"), { code: "EIO" });
  assert.equal(closes, 1); assert.equal(opened.fd, -1);
});

test("repeated refused reads leave no descriptor behind", { skip: process.platform !== "linux" }, async t => {
  const { workspace, config } = await fixture(t);
  await fs.writeFile(path.join(workspace, "legacy.txt"), Buffer.from([0xff]));
  const before = (await fs.readdir("/proc/self/fd")).length;
  for (let i = 0; i < 32; i++) await assert.rejects(read(config, "legacy.txt"), /not valid UTF-8/);
  assert.equal((await fs.readdir("/proc/self/fd")).length, before);
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
for (const scope of ["internal", "external", "blocked", "explicit"]) test("local image read uses the same " + scope + " authority", async t => {
  const { workspace, other, config } = await fixture(t);
  const image = scope === "internal" ? path.join(workspace, "source.png")
    : scope === "blocked" ? path.join(workspace, ".env") : path.join(other, "source.png");
  await fs.writeFile(image, png); await fs.symlink(image, path.join(workspace, "linked.png"));
  if (scope === "explicit") config.readOnlyRoots = [other];
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => { requests++; throw Error("No network allowed"); });
  const result = await readImage({ path: "linked.png", prompt: "Describe the image.", dryRun: true }, config);
  assert.equal(requests, 0);
  if (["internal", "explicit"].includes(scope)) {
    assert.equal(result.ok, true); assert.equal(result.provider, "dry-run"); assert.equal(result.images[0].sha256, hash(png));
  } else {
    assert.equal(result.ok, false); assert.equal(result.blocked, true); assert.deepEqual(result.images, []);
    assert.equal(JSON.stringify(result).includes("violet lighthouse"), false);
  }
});

function bounded(promise, label, ms = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " timed out")), ms); })])
    .finally(() => clearTimeout(timer));
}
async function preview(t, workspace) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../src/static-preview-server.js"), workspace, "0"],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", AGINTIFLOW_PREVIEW_TTL_MS: "60000" } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit"); child.kill("SIGTERM");
      try { await bounded(exit, "owned preview cleanup"); }
      catch (error) { child.kill("SIGKILL"); await bounded(once(child, "close"), "owned preview force cleanup"); throw error; }
    }
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(Error("Preview exited before readiness")));
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) resolve("http://127.0.0.1:" + match[1]);
    });
  });
  return bounded(ready, "preview startup");
}

test("preview HTTP cannot serve external, hidden or directory-index aliases", { timeout: 15000 }, async t => {
  const { workspace, other } = await fixture(t);
  await fs.writeFile(path.join(workspace, "index.html"), "<p>Authorized preview</p>");
  await fs.writeFile(path.join(other, "index.html"), excluded);
  await fs.writeFile(path.join(workspace, ".env"), excluded);
  await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "linked.txt"));
  await fs.symlink(other, path.join(workspace, "linked-dir"));
  await fs.symlink(path.join(workspace, ".env"), path.join(workspace, "visible.txt"));
  await fs.symlink(path.join(workspace, "index.html"), path.join(workspace, "inside.html"));
  const origin = await preview(t, workspace);
  for (const name of ["linked.txt", "linked-dir/", "visible.txt"]) for (const method of ["GET", "HEAD"]) {
    const response = await fetch(origin + "/" + name, { method, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 403); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.text()).includes("violet lighthouse"), false);
  }
  const response = await fetch(origin + "/inside.html", { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); assert.equal(await response.text(), "<p>Authorized preview</p>");
  assert.equal((await fetch(origin + "/missing", { signal: AbortSignal.timeout(3000) })).status, 404);
  const sparse = await fs.open(path.join(workspace, "large.pdf"), "wx");
  try { await sparse.truncate(32 * 1024 * 1024 + 1); } finally { await sparse.close(); }
  assert.equal((await fetch(origin + "/large.pdf", { signal: AbortSignal.timeout(3000) })).status, 413);
  await fs.truncate(path.join(workspace, "large.pdf"), 32 * 1024 * 1024);
  const head = await fetch(origin + "/large.pdf", { method: "HEAD", signal: AbortSignal.timeout(3000) });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(32 * 1024 * 1024));
});

test("a preview server never adopts a successor workspace after replacement", { timeout: 15000 }, async t => {
  const { root, workspace } = await fixture(t); await fs.writeFile(path.join(workspace, "index.html"), "original");
  const origin = await preview(t, workspace);
  assert.equal(await (await fetch(origin, { signal: AbortSignal.timeout(3000) })).text(), "original");
  await fs.rename(workspace, path.join(root, "prior")); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "index.html"), excluded);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(origin, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 500); assert.equal((await response.text()).includes("violet lighthouse"), false);
  }
});

for (const [tool, allowed, scs, variant = "normal"] of [["read_file", false, false], ["read_file", false, true],
  ["read_file", true, false], ["read_file", true, true], ["open_workspace_file", false, false], ["preview_workspace", false, false],
  ["send_to_canvas", false, false], ["read_image", false, false], ["read_file", false, false, "batch"],
  ["read_file", false, false, "recover"], ["read_file", true, false, "incidental"]]) {
  test("persisted native " + tool + " scope (allowed " + allowed + ", SCS " + scs + ", " + variant + ")", { timeout: 20000 }, async t => {
    const { root, workspace, other } = await fixture(t);
    const name = tool === "read_file" ? "note.txt" : tool === "read_image" ? "note.png" : "note.html";
    await fs.symlink(allowed ? path.join(workspace, "source.txt") : path.join(other, "record.txt"), path.join(workspace, name));
    const { runAgent } = await import("../src/agent-runner.js");
    const { resolveRuntimeConfig } = await import("../src/config.js");
    const { closeSessionIndexConnections } = await import("../src/session-index.js");
    const { chromium } = await import("playwright"); let browserLaunches = 0;
    t.mock.method(chromium, "launch", () => { browserLaunches++; throw Error("No browser may start for this refusal"); });
    const oldHome = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(root, "home");
    const originalFetch = globalThis.fetch; let requests = 0, step = 0, output = "", recovering = false;
    if (variant === "incidental") await fs.symlink(path.join(other, "record.txt"), path.join(workspace, "extra.txt"));
    const seen = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(url).href, "https://offline.invalid/v1/chat/completions");
      const body = JSON.parse(init.body); seen.push(body); requests++;
      assert.equal(JSON.stringify(body).includes("violet lighthouse"), false, "unadmitted source entered model context");
      const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: "scope_" + requests, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      let message;
      if (!body.tools) message = { role: "assistant", content: "Read the authorized source, create the requested report if possible, and finish honestly." };
      else if (!body.tools.some(t => t.function.name === tool) && body.tools.some(t => t.function.name === "inspect_project")) message = call("inspect_project", {});
      else {
        step++;
        const current = variant === "incidental" ? step - 1 : step;
        if (variant === "incidental" && step === 1) message = call("read_file", { path: "extra.txt" });
        else if (current === 1) {
          message = call(tool, { path: name, ...(tool === "send_to_canvas" ? { title: "Source", kind: "file" } : {}) });
          if (variant === "batch" && !recovering) message.tool_calls.push(...call("write_file", { path: "report.md", content: "UNVERIFIED REPORT", mode: "create" }).tool_calls.map(c => ({ ...c, id: c.id + "_write" })));
        } else if (!allowed && !recovering) assert.fail("a required-scope refusal must not request another model turn");
        else if (current === 2) {
          const observed = JSON.parse(body.messages.filter(message => message.role === "tool").at(-1).content);
          assert.equal(observed.content, authorized); output = "# Report\n" + observed.content;
          message = call("write_file", { path: "report.md", content: output, mode: "create" });
        } else if (current === 3) message = call("read_file", { path: "report.md" });
        else message = call("finish", { result: "Created report.md from note.txt; the source remains unchanged." });
      }
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const goal = tool === "read_file" ? "Make report.md from note.txt. Don't change note.txt."
        : "Use " + tool + " to inspect " + name + ". Do not edit any file.";
      const config = resolveRuntimeConfig({ goal, provider: "deepseek", model: "deepseek-flash", routingMode: "manual",
        taskProfile: "code", commandCwd: workspace, maxSteps: 5, dynamicSteps: "off" }, {
        baseDir: workspace, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "scope-test", apiKey: "synthetic-offline-key",
        baseURL: "https://offline.invalid/v1", sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true,
        allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false,
        allowParallelScouts: false, onConsole() {}, onEvent() {}, onLog() {},
      });
      Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
        enableScs: scs ? "on" : "off", scsActive: scs, scsValidationMode: "deterministic", allowProviderHandoff: false, modelTimeoutMs: 5000,
        mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash", routeProvider: "deepseek", routeModel: "deepseek-flash" });
      const result = await runAgent(config);
      const stateText = await fs.readFile(path.join(root, "sessions/scope-test/state.json"), "utf8");
      const eventsText = await fs.readFile(path.join(root, "sessions/scope-test/events.jsonl"), "utf8");
      const events = eventsText.trim().split("\n").map(JSON.parse);
      assert.equal((stateText + eventsText).includes("violet lighthouse"), false); assert.equal(browserLaunches, 0);
      assert.equal(await fs.readFile(path.join(other, "record.txt"), "utf8"), excluded);
      if (allowed) {
        assert.equal(result.goalStatus, "completed");
        assert.equal(await fs.readFile(path.join(workspace, "report.md"), "utf8"), output);
        const before = requests;
        const resumed = await runAgent({ ...config, resume: "scope-test", goal: "Continue the same task." });
        assert.equal(resumed.goalStatus, "completed"); assert.equal(requests, before);
      } else {
        assert.equal(result.stopped, true); assert.equal(result.reason, "required_source_unavailable");
        assert.equal(result.goalStatus, "paused"); assert.equal(step, 1, "the first hard refusal must stop model work");
        assert.match(result.result, /permitted read scope/);
        assert.deepEqual(events.filter(event => event.type === "file.changed"), []);
        assert.ok(events.some(event => event.type === "tool.failed" && /permitted scope/.test(JSON.stringify(event.data))));
        await assert.rejects(fs.stat(path.join(workspace, "report.md")), { code: "ENOENT" });
        if (variant === "batch") {
          assert.ok(events.some(event => event.type === "tool.batch_deferred" &&
            event.data.dispatchedTool === "read_file" && event.data.deferredTools.includes("write_file")));
          assert.equal(events.some(event => event.type === "tool.started" && event.data.toolName === "write_file"), false);
        }
        if (variant === "recover") {
          await fs.unlink(path.join(workspace, name)); await fs.writeFile(path.join(workspace, name), authorized);
          recovering = true; step = 0;
          const before = requests, previousRevision = JSON.parse(stateText).meta.runtimeConfig.revision;
          const resumed = await runAgent({ ...config, resume: "scope-test", expectedRuntimeRevision: previousRevision, goal: "Continue the same task." });
          assert.equal(resumed.goalStatus, "completed"); assert.ok(requests - before <= 6);
          assert.equal(await fs.readFile(path.join(workspace, "report.md"), "utf8"), "# Report\n" + authorized);
          const saved = JSON.parse(await fs.readFile(path.join(root, "sessions/scope-test/state.json"), "utf8"));
          assert.equal(saved.meta.runtimeConfig.revision, previousRevision, "ordinary resume does not patch runtime configuration");
          assert.ok(saved.meta.goalContract.revision > JSON.parse(stateText).meta.goalContract.revision);
        }
      }
      assert.ok(requests <= (variant === "recover" ? 10 : 7));
    } finally {
      globalThis.fetch = originalFetch; closeSessionIndexConnections();
      if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    }
  });
}

for (const scope of ["internal", "external", "blocked"]) test("canvas persistence enforces " + scope + " source authority", async t => {
  const { root, workspace, other, config } = await fixture(t);
  const source = scope === "internal" ? path.join(workspace, "source.txt") : scope === "blocked"
    ? path.join(workspace, ".env") : path.join(other, "record.txt");
  if (scope === "blocked") await fs.writeFile(source, excluded);
  await fs.symlink(source, path.join(workspace, "linked.txt"));
  let ensured = 0;
  const store = { sessionDir: path.join(root, "session"), artifactsDir: path.join(root, "session/artifacts"),
    async ensure() { ensured++; await fs.mkdir(this.artifactsDir, { recursive: true }); } };
  const normalized = normalizeCanvasPayload({ title: "Source review", path: "linked.txt", kind: "text" }, config);
  assert.equal(normalized.ok, true);
  const result = await persistCanvasPayloadFile(normalized.payload, { config, store });
  if (scope === "internal") {
    assert.equal(result.ok, true); assert.equal(result.payload.artifactPersisted, true);
    assert.equal(await fs.readFile(result.payload.sessionFilePath, "utf8"), authorized);
    assert.equal(result.payload.artifactBytes, Buffer.byteLength(authorized));
  } else {
    assert.equal(result.ok, false); assert.equal(ensured, 0);
    await assert.rejects(fs.stat(store.sessionDir), { code: "ENOENT" });
    assert.equal(JSON.stringify(result).includes("violet lighthouse"), false);
  }
});

for (const type of ["workspace-file", "session-file"]) for (const scope of ["internal", "external", "blocked"]) {
  test("artifact " + type + " resolver enforces " + scope + " scope", async t => {
    const { root, workspace, other, config } = await fixture(t);
    const store = { sessionDir: path.join(root, "session") }; await fs.mkdir(store.sessionDir);
    const anchor = type === "workspace-file" ? workspace : store.sessionDir;
    const source = scope === "internal" ? path.join(anchor, "source.txt") : scope === "blocked"
      ? path.join(anchor, ".env") : path.join(other, "record.txt");
    await fs.writeFile(source, scope === "internal" ? authorized : excluded);
    const link = path.join(anchor, "linked.txt"); await fs.symlink(source, link);
    const item = { id: "artifact_read_scope", sessionId: "scope-test", title: "Source", path: "linked.txt", kind: "text",
      ref: { type, path: type === "workspace-file" ? "linked.txt" : link } };
    const resolved = await resolveArtifactFile(item, { config, store });
    const content = await readArtifactContent(item, { config, store });
    if (scope === "internal") {
      assert.equal(resolved.ok, true); assert.equal(resolved.absolutePath, source);
      assert.equal(content.ok, true); assert.equal(content.text, authorized);
    } else {
      assert.equal(resolved.ok, false); assert.equal(content.ok, false);
      assert.equal(JSON.stringify(content).includes("violet lighthouse"), false);
    }
  });
}

test("non-UTF-8 artifact preview keeps exact downloadable bytes rather than replacement text", async t => {
  const { workspace, config } = await fixture(t); const bytes = Buffer.from([0x63,0x61,0x66,0xe9,0x0a]);
  const file = path.join(workspace, "legacy.txt"); await fs.writeFile(file, bytes);
  const item = { id: "artifact_legacy", sessionId: "scope-test", title: "Legacy source", path: "legacy.txt", kind: "text",
    ref: { type: "workspace-file", path: "legacy.txt" } };
  const result = await readArtifactContent(item, { config });
  assert.equal(result.ok, true); assert.equal(result.binary, true); assert.equal(Object.hasOwn(result, "text"), false);
  assert.match(result.preview, /Non-UTF-8/); assert.deepEqual(await fs.readFile(file), bytes);
});
