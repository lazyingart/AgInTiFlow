import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseRestrictedJson } from "./restricted-application-contract.js";

export const LONG_JOB_METADATA_MAX_BYTES = 128 * 1024;
const identities = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
const filenames = new Set(["job.json", "status.json", "supervisor.mjs", "command.txt", "verify.txt", "status.md", "events.jsonl"]);
const same = (a, b) => identities.every(key => a[key] === b[key]);
export function longJobMetadataError(changed = false) {
  return Object.assign(new Error("Long-job metadata is unavailable or unsafe. Use a valid job recorded in this workspace; stronger command permissions do not repair metadata."),
    { code: changed ? "LONG_JOB_METADATA_CHANGED" : "LONG_JOB_METADATA_UNAVAILABLE" });
}
function owned(stat, directory) {
  return (directory ? stat.isDirectory() : stat.isFile()) &&
    (typeof process.geteuid !== "function" || stat.uid === BigInt(process.geteuid())) &&
    (stat.mode & 0o7022n) === 0n && (directory ? stat.nlink >= 1n : stat.nlink === 1n);
}

// Native workspace control files, not a retained-descriptor storage authority.
// Named-path checks reject ordinary symlink/hardlink redirection and concurrent
// changes. They are not openat/openat2 or isolation from a namespace writer.
// Applications still require separately qualified storage/process boundaries.
export async function openLongJobMetadata(root, jobId, { create = false } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root) ||
      typeof jobId !== "string" || !/^[A-Za-z0-9_.+-]{8,140}$/.test(jobId)) throw longJobMetadataError();
  const rootName = path.resolve(root), canonicalRoot = await fs.realpath(rootName);
  const rootStat = await fs.stat(canonicalRoot, { bigint: true });
  if (!rootStat.isDirectory()) throw longJobMetadataError();
  const bindings = [];
  let directory = canonicalRoot;
  for (const segment of [".aginti", "long-jobs", jobId]) {
    directory = path.join(directory, segment);
    if (create) {
      try { await fs.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST" || segment === jobId) throw error; }
    }
    const stat = await fs.lstat(directory, { bigint: true });
    if (!owned(stat, true) || await fs.realpath(directory) !== directory) throw longJobMetadataError();
    bindings.push({ directory, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode });
  }
  async function verify() {
    if (await fs.realpath(rootName) !== canonicalRoot) throw longJobMetadataError();
    const currentRoot = await fs.stat(canonicalRoot, { bigint: true });
    if (!currentRoot.isDirectory() || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) throw longJobMetadataError();
    for (const binding of bindings) {
      const stat = await fs.lstat(binding.directory, { bigint: true });
      if (!owned(stat, true) || ["dev", "ino", "uid", "gid", "mode"].some(key => stat[key] !== binding[key]) ||
          await fs.realpath(binding.directory) !== binding.directory) throw longJobMetadataError();
    }
  }
  const location = name => {
    if (!filenames.has(name)) throw longJobMetadataError();
    return path.join(directory, name);
  };
  async function read(name) {
    if (!["job.json", "status.json"].includes(name)) throw longJobMetadataError();
    await verify();
    const filename = location(name);
    const named = await fs.lstat(filename, { bigint: true });
    if (!owned(named, false)) throw longJobMetadataError();
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const stat = await handle.stat({ bigint: true });
      // A normal rename may unlink this exact previously safe inode between
      // open and fstat. Retry a fresh snapshot without reading the old handle;
      // do not reclassify hardlinks, changed owner/mode or a foreign inode.
      if (stat.isFile() && stat.nlink === 0n &&
          ["dev", "ino", "uid", "gid", "mode"].every(key => stat[key] === named[key])) throw longJobMetadataError(true);
      if (!owned(stat, false) || stat.size > BigInt(LONG_JOB_METADATA_MAX_BYTES)) throw longJobMetadataError();
      if (!same(named, stat)) throw longJobMetadataError(true);
      const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw longJobMetadataError(true);
        offset += read.bytesRead;
      }
      const tail = await handle.read(Buffer.alloc(1), 0, 1, offset);
      if (tail.bytesRead || !same(stat, await handle.stat({ bigint: true })) ||
          !same(stat, await fs.lstat(filename, { bigint: true }))) throw longJobMetadataError(true);
      let data;
      try { data = parseRestrictedJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw longJobMetadataError(); }
      await verify();
      return { data, filename, stat };
    } finally { await handle.close(); }
  }
  async function verifySnapshot(snapshot) {
    await verify();
    if (!same(snapshot.stat, await fs.lstat(snapshot.filename, { bigint: true }))) throw longJobMetadataError();
  }
  async function writeNew(name, content) {
    if (!create || typeof content !== "string" || !content.isWellFormed() ||
        Buffer.byteLength(content) > (name === "supervisor.mjs" ? 256 * 1024 : LONG_JOB_METADATA_MAX_BYTES)) throw longJobMetadataError();
    await verify();
    const filename = location(name), handle = await fs.open(filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (!owned(await handle.stat({ bigint: true }), false)) throw longJobMetadataError();
      await handle.writeFile(content); await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!owned(stat, false) || !same(stat, await fs.lstat(filename, { bigint: true }))) throw longJobMetadataError();
      await verify();
    } finally { await handle.close(); }
  }
  await verify();
  return Object.freeze({ read, verify, verifySnapshot, writeNew });
}
