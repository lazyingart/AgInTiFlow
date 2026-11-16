import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { readProjectInstructions } from "../src/project.js";
import { createWorkspaceReadBoundary, readWorkspaceFileSnapshot } from "../src/workspace-read-boundary.js";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-project-instructions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), foreign = path.join(root, "not-admitted");
  await fs.mkdir(workspace); await fs.mkdir(foreign);
  return { root, workspace, foreign, file: path.join(workspace, "AGINTI.md") };
}
function patch(t, object, key, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { ...descriptor, value: wrap(descriptor.value) });
  t.after(() => Object.defineProperty(object, key, descriptor));
}
function unavailable(result) {
  assert.equal(result.exists, false); assert.equal(result.content, ""); assert.equal(result.truncated, false);
}

test("ordinary project instructions remain exact and non-mutating", async t => {
  const f = await fixture(t), content = "# Project\n保留输入。Use the supplied references.\n";
  await fs.writeFile(f.file, content); const before = await fs.stat(f.file, { bigint: true });
  assert.deepEqual(await readProjectInstructions(f.workspace), { exists: true, path: f.file, content, truncated: false });
  const after = await fs.stat(f.file, { bigint: true });
  // A read may legitimately advance atime; content and mutation identity must
  // remain unchanged.
  for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[key], before[key]);
});

for (const kind of ["outside", "sensitive", "dangling", "directory"]) {
  test("implicit instructions refuse " + kind + " targets", async t => {
    const f = await fixture(t);
    if (kind === "directory") await fs.mkdir(f.file);
    else {
      const target = kind === "sensitive" ? path.join(f.workspace, ".env") : path.join(f.foreign, "instructions.md");
      if (kind !== "dangling") await fs.writeFile(target, "SYNTHETIC_UNADMITTED_INSTRUCTION_ROW\n");
      await fs.symlink(target, f.file);
    }
    unavailable(await readProjectInstructions(f.workspace));
  });
}

test("an explicitly selected root alias and an ordinary in-project alias remain usable", async t => {
  const f = await fixture(t), source = path.join(f.workspace, "references/instructions.md"), alias = path.join(f.root, "selected");
  await fs.mkdir(path.dirname(source)); await fs.writeFile(source, "# Approved project guidance\n");
  await fs.symlink(source, f.file); await fs.symlink(f.workspace, alias);
  for (const root of [f.workspace, alias]) assert.equal((await readProjectInstructions(root)).content, "# Approved project guidance\n");
});

for (const bytes of [Buffer.from([0x61, 0xff, 0x62]), Buffer.from([0x61, 0, 0x62]), Buffer.from([0xe2, 0x82])]) {
  test("non-text instructions never enter context: " + bytes.toString("hex"), async t => {
    const f = await fixture(t); await fs.writeFile(f.file, bytes);
    unavailable(await readProjectInstructions(f.workspace)); assert.deepEqual(await fs.readFile(f.file), bytes);
  });
}

test("literal replacement characters are valid text, rather than a decoding-error heuristic", async t => {
  const f = await fixture(t); await fs.writeFile(f.file, "Literal \ufffd remains literal.\n");
  assert.equal((await readProjectInstructions(f.workspace)).content, "Literal \ufffd remains literal.\n");
});

test("prefix limits preserve exact Unicode without replacement and retain truthful truncation", async t => {
  const f = await fixture(t), content = "ab中日\n";
  await fs.writeFile(f.file, content);
  for (const [maxBytes, prefix] of [[0, ""], [1, "a"], [2, "ab"], [3, "ab"], [4, "ab"], [5, "ab中"], [8, "ab中日"]]) {
    const result = await readProjectInstructions(f.workspace, { maxBytes });
    assert.equal(result.exists, true); assert.equal(result.content, prefix); assert.equal(result.truncated, true);
  }
  const exact = await readProjectInstructions(f.workspace, { maxBytes: Buffer.byteLength(content) });
  assert.equal(exact.content, content); assert.equal(exact.truncated, false);
  const boundary = await createWorkspaceReadBoundary({ root: f.workspace });
  await assert.rejects(readWorkspaceFileSnapshot(f.file, boundary, { maxBytes: 5, text: true }), { code: "WORKSPACE_READ_TOO_LARGE" });
});

test("a large instruction file reads a bounded prefix and never allocates by its untrusted size", async t => {
  const f = await fixture(t); await fs.writeFile(f.file, "x".repeat(128_000));
  let observed = 0;
  patch(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === f.file) {
      const read = handle.read.bind(handle);
      handle.read = async (buffer, ...rest) => { observed = Math.max(observed, buffer.length); return read(buffer, ...rest); };
    }
    return handle;
  });
  const result = await readProjectInstructions(f.workspace);
  assert.equal(result.content, "x".repeat(24_000)); assert.equal(result.truncated, true); assert.equal(observed, 24_000);
});

for (const kind of ["alias-before-open", "replacement-after-read", "mutation-after-read"]) {
  test("a changed instruction binding is withheld: " + kind, async t => {
    const f = await fixture(t), other = path.join(f.foreign, "instructions.md");
    await fs.writeFile(f.file, "# Original guidance\n"); await fs.writeFile(other, "SYNTHETIC_UNADMITTED_INSTRUCTION_ROW\n");
    let injected = false;
    patch(t, fs, "open", original => async (...args) => {
      if (args[0] === f.file && kind === "alias-before-open" && !injected) {
        injected = true; await fs.unlink(f.file); await fs.symlink(other, f.file);
      }
      const handle = await Reflect.apply(original, fs, args);
      if (args[0] === f.file && kind !== "alias-before-open") {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          if (!injected) {
            injected = true;
            if (kind === "replacement-after-read") { await fs.unlink(f.file); await fs.writeFile(f.file, "# Replacement\n"); }
            else await fs.appendFile(f.file, "# Changed\n");
          }
          return result;
        };
      }
      return handle;
    });
    unavailable(await readProjectInstructions(f.workspace)); assert.equal(injected, true);
  });
}

test("a FIFO cannot strand implicit context loading", { timeout: 5000, skip: process.platform === "win32" }, async t => {
  const f = await fixture(t); await exec("mkfifo", [f.file]);
  unavailable(await readProjectInstructions(f.workspace));
});

test("missing optional instructions keep their original unavailable contract", async t => {
  const f = await fixture(t); unavailable(await readProjectInstructions(f.workspace));
});

for (const maxBytes of [-1, 1.5, NaN, Infinity, "24", 64 * 1024 * 1024 + 1]) {
  test("invalid prefix limit fails closed without opening instructions: " + String(maxBytes), async t => {
    const f = await fixture(t); await fs.writeFile(f.file, "# Project\n"); let opens = 0;
    patch(t, fs, "open", original => async (...args) => { opens++; return Reflect.apply(original, fs, args); });
    unavailable(await readProjectInstructions(f.workspace, { maxBytes })); assert.equal(opens, 0);
  });
}

test("short regular-file reads are completed within the same verified handle", async t => {
  const f = await fixture(t), text = "# Guidance\nKeep the source unchanged.\n"; await fs.writeFile(f.file, text);
  let reads = 0, closes = 0;
  patch(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === f.file) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = async (buffer, offset, length, position) => { reads++; return read(buffer, offset, Math.min(3, length), position); };
      handle.close = async () => { closes++; return close(); };
    }
    return handle;
  });
  assert.equal((await readProjectInstructions(f.workspace)).content, text); assert.ok(reads > 2); assert.equal(closes, 1);
});

test("an early EOF refuses the partial content and closes its handle exactly once", async t => {
  const f = await fixture(t); await fs.writeFile(f.file, "# Guidance\n"); let closes = 0;
  patch(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === f.file) {
      const close = handle.close.bind(handle);
      handle.read = async () => ({ bytesRead: 0 });
      handle.close = async () => { closes++; return close(); };
    }
    return handle;
  });
  unavailable(await readProjectInstructions(f.workspace)); assert.equal(closes, 1);
});

test("handle-close failure cannot publish instruction content or retry a closed descriptor", async t => {
  const f = await fixture(t); await fs.writeFile(f.file, "# Guidance\n"); let closes = 0;
  patch(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (args[0] === f.file) {
      const close = handle.close.bind(handle);
      handle.close = async () => { closes++; await close(); throw Object.assign(Error("Synthetic close failure"), { code: "EIO" }); };
    }
    return handle;
  });
  unavailable(await readProjectInstructions(f.workspace)); assert.equal(closes, 1);
});
