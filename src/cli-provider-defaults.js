import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeProviderId } from "./provider-contract.js";

const FILENAME = "cli-provider-default.json";
const supported = () => ["linux", "darwin"].includes(process.platform);
const home = (env) => path.resolve(env.AGINTIFLOW_HOME || path.join(os.homedir(), ".agintiflow"));
const encode = (provider) => `${JSON.stringify({ schemaVersion: 1, provider })}\n`;
function unavailable() {
  return Object.assign(new Error("CLI provider default is unavailable or invalid. Saved preferences require a canonical owned home without group/other write permission and a private 0600 file."), { code: "CLI_PROVIDER_DEFAULT_INVALID" });
}
function same(a, b, isDirectory = false) {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && (isDirectory || a.nlink === b.nlink);
}
function directory(root) {
  const s = fs.lstatSync(root, { bigint: true });
  if (!s.isDirectory() || s.uid !== BigInt(process.getuid()) || (s.mode & 0o7022n) || s.nlink < 1n || fs.realpathSync(root) !== root) throw unavailable();
  return s;
}
function regular(s) {
  return s.isFile() && s.uid === BigInt(process.getuid()) && (s.mode & 0o7777n) === 0o600n && s.nlink === 1n && s.size <= 4096n;
}

// Personal, non-secret CLI preference only. SDKs, services and headless commands
// do not read it. Atomic replacement prevents torn settings; concurrent explicit
// writes are last-writer-wins. This is not a retained-descriptor service store or
// a security boundary against another process running as the same OS account.
export function readCliProviderDefault(env = process.env) {
  if (!supported()) return null;
  const root = home(env), filename = path.join(root, FILENAME);
  let fd;
  try {
    let named;
    try { named = fs.lstatSync(filename, { bigint: true }); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    // An absent opt-in must not change legacy startup, including legacy homes
    // created with a group-writable umask. A present preference still requires
    // the complete owned-directory/file validation before it can select a model.
    const rootStat = directory(root);
    if (!regular(named)) throw unavailable();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!regular(opened) || !same(named, opened)) throw unavailable();
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 4096 || !same(rootStat, directory(root), true) || !same(opened, fs.fstatSync(fd, { bigint: true })) || !same(opened, fs.lstatSync(filename, { bigint: true }))) throw unavailable();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).length !== 2 || !Object.hasOwn(value, "provider")) throw unavailable();
    if (value.provider !== null && (typeof value.provider !== "string" || normalizeProviderId(value.provider, "") !== value.provider)) throw unavailable();
    if (!Buffer.from(encode(value.provider)).equals(bytes)) throw unavailable();
    return value.provider;
  } catch { throw unavailable(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function writeCliProviderDefault(provider, env = process.env) {
  if (!supported()) throw Object.assign(new Error("CLI provider defaults currently require Linux or macOS."), { code: "CLI_PROVIDER_DEFAULT_UNSUPPORTED" });
  if (provider !== null && (typeof provider !== "string" || !normalizeProviderId(provider, ""))) throw unavailable();
  provider = provider === null ? null : normalizeProviderId(provider, "");
  const root = home(env), filename = path.join(root, FILENAME);
  const temporary = path.join(root, `.${FILENAME}.${randomUUID()}.tmp`);
  let fd;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStat = directory(root);
    readCliProviderDefault(env); // Refuse to overwrite an unsafe existing file.
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, encode(provider)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!same(rootStat, directory(root), true)) throw unavailable();
    fs.renameSync(temporary, filename);
    const dir = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    if (readCliProviderDefault(env) !== provider) throw unavailable();
    return provider;
  } catch { throw unavailable(); }
  finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

export function selectStandaloneCliProvider(args, env = process.env) {
  // Explicit runtime/environment authority wins, including a saved resume.
  return args.provider || env.AGENT_PROVIDER || readCliProviderDefault(env) || "";
}

export function cliProviderDefaultsCommand(argv, env = process.env) {
  let provider;
  if (!argv.length || (argv.length === 1 && argv[0] === "status")) provider = readCliProviderDefault(env);
  else if (argv.length === 3 && argv[0] === "set" && argv[1] === "--provider") provider = writeCliProviderDefault(argv[2], env);
  else if (argv.length === 1 && argv[0] === "reset") provider = writeCliProviderDefault(null, env);
  else throw new Error("Usage: aginti defaults status | defaults set --provider PROVIDER | defaults reset");
  return { schemaVersion: 1, scope: "standalone-cli-new-runs", provider, headlessRuns: false, sdk: false, savedSessions: "unchanged" };
}
