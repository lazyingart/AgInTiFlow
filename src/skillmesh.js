import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { agintiflowHome } from "./session-index.js";
import { loadDatabaseSync } from "./sqlite.js";
import { loadSkillFile, listSkills } from "./skill-library.js";
import { redactSensitiveText } from "./redaction.js";

const PROTOCOL_VERSION = 1;
const MAX_PACK_BYTES = 2 * 1024 * 1024;
const MAX_SKILLS_PER_PACK = 5;
const MAX_SKILL_BYTES = 80 * 1024;
const MAX_FEED_PACKS = 200;
const DEFAULT_NODE_URL = "https://skills.flow.lazying.art";
const DEFAULT_SERVICE_NAME = "aginti-skill-relay";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const FORBIDDEN_PATH_PARTS = [
  ".env",
  ".git",
  ".aginti-sessions",
  ".sessions",
  "events.jsonl",
  "state.json",
  "storage-state.json",
  "session.json",
  "cookies.json",
];

export function skillMeshPaths(home = agintiflowHome()) {
  const root = path.join(home, "skillmesh");
  return {
    root,
    configPath: path.join(root, "config.json"),
    identityPath: path.join(root, "identity.json"),
    indexDbPath: path.join(root, "index.sqlite"),
    skillsDir: path.join(root, "skills"),
    packsDir: path.join(root, "packs"),
    inboxDir: path.join(root, "inbox"),
    outboxDir: path.join(root, "outbox"),
    reviewedDir: path.join(root, "reviewed"),
    rejectedDir: path.join(root, "rejected"),
    feedsDir: path.join(root, "feeds"),
  };
}

export function defaultSkillMeshConfig() {
  return {
    version: 1,
    mode: "share",
    nodes: [{ name: "lazyingart", url: DEFAULT_NODE_URL, role: "major", enabled: true }],
    shareRequiresReview: true,
    autoEnableImportedSkills: false,
    downloadPolicy: {
      autoDownloadMetadata: true,
      autoDownloadPacks: false,
      autoEnableSkills: false,
      allowPolicyChanges: false,
      allowExecutableTests: false,
    },
    syncPolicy: {
      idleOnly: true,
      minIntervalMinutes: 360,
      maxOutboundPacksPerDay: 3,
      maxInboundPacksPerSync: 20,
      metadataFirst: true,
      lastSyncAt: "",
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUrl(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonSync(filePath, fallback = null) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function ensureSkillMeshHome(home = agintiflowHome()) {
  const paths = skillMeshPaths(home);
  await Promise.all([
    fs.mkdir(paths.root, { recursive: true }),
    fs.mkdir(paths.skillsDir, { recursive: true }),
    fs.mkdir(paths.packsDir, { recursive: true }),
    fs.mkdir(paths.inboxDir, { recursive: true }),
    fs.mkdir(paths.outboxDir, { recursive: true }),
    fs.mkdir(paths.reviewedDir, { recursive: true }),
    fs.mkdir(paths.rejectedDir, { recursive: true }),
    fs.mkdir(paths.feedsDir, { recursive: true }),
  ]);
  if (!(await exists(paths.configPath))) await writeJson(paths.configPath, defaultSkillMeshConfig());
  ensureSkillMeshDb(paths.indexDbPath);
  return paths;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadSkillMeshConfig(home = agintiflowHome()) {
  const paths = await ensureSkillMeshHome(home);
  const loaded = await readJson(paths.configPath, {});
  const defaults = defaultSkillMeshConfig();
  return {
    ...defaults,
    ...loaded,
    nodes: Array.isArray(loaded.nodes) && loaded.nodes.length ? loaded.nodes : defaults.nodes,
    downloadPolicy: { ...defaults.downloadPolicy, ...(loaded.downloadPolicy || {}) },
    syncPolicy: { ...defaults.syncPolicy, ...(loaded.syncPolicy || {}) },
  };
}

export function loadSkillMeshConfigSync(home = agintiflowHome()) {
  const paths = skillMeshPaths(home);
  const loaded = readJsonSync(paths.configPath, {});
  const defaults = defaultSkillMeshConfig();
  return {
    ...defaults,
    ...loaded,
    nodes: Array.isArray(loaded.nodes) && loaded.nodes.length ? loaded.nodes : defaults.nodes,
    downloadPolicy: { ...defaults.downloadPolicy, ...(loaded.downloadPolicy || {}) },
    syncPolicy: { ...defaults.syncPolicy, ...(loaded.syncPolicy || {}) },
  };
}

async function saveSkillMeshConfig(config, home = agintiflowHome()) {
  const paths = await ensureSkillMeshHome(home);
  await writeJson(paths.configPath, config);
  return config;
}

export async function setSkillMeshMode(mode, home = agintiflowHome()) {
  const normalized = normalizeMode(mode);
  const config = await loadSkillMeshConfig(home);
  config.mode = normalized;
  await saveSkillMeshConfig(config, home);
  return config;
}

export async function addSkillMeshNode(name, url, { home = agintiflowHome(), role = "volunteer" } = {}) {
  const cleanName = String(name || "").trim() || "node";
  const cleanUrl = normalizeUrl(url);
  if (!/^https?:\/\//.test(cleanUrl)) throw new Error(`Invalid node URL: ${url}`);
  const config = await loadSkillMeshConfig(home);
  const nextNode = { name: cleanName, url: cleanUrl, role, enabled: true, addedAt: nowIso() };
  config.nodes = (config.nodes || []).filter((node) => normalizeUrl(node.url) !== cleanUrl && node.name !== cleanName);
  config.nodes.push(nextNode);
  await saveSkillMeshConfig(config, home);
  return nextNode;
}

export async function removeSkillMeshNode(nameOrUrl, { home = agintiflowHome() } = {}) {
  const target = String(nameOrUrl || "").trim();
  const config = await loadSkillMeshConfig(home);
  const before = (config.nodes || []).length;
  config.nodes = (config.nodes || []).filter((node) => node.name !== target && normalizeUrl(node.url) !== normalizeUrl(target));
  await saveSkillMeshConfig(config, home);
  return before - config.nodes.length;
}

export function normalizeMode(value = "") {
  const text = String(value || "").toLowerCase().trim();
  if (["off", "disable", "disabled", "none", "0"].includes(text)) return "off";
  if (["record", "local", "private"].includes(text)) return "record";
  if (["share", "record-share", "record+share", "sync", "on", "1", ""].includes(text)) return "share";
  throw new Error(`Unknown Skill Mesh mode: ${value}`);
}

export function skillMeshModeChoices() {
  return [
    {
      value: "share",
      label: "Record + Share Reviewed Skills",
      description: "Default. Record locally; share only signed, reviewed, redacted skill packs.",
    },
    {
      value: "record",
      label: "Record Locally",
      description: "Keep sanitized skill-learning metadata local; no network sync.",
    },
    {
      value: "off",
      label: "Disabled",
      description: "Do not use Skill Mesh recording, imports, or sync.",
    },
  ];
}

export function formatSkillMeshStatus(config) {
  const nodes = (config.nodes || []).filter((node) => node.enabled !== false);
  return [
    `Skill Mesh: ${config.mode}`,
    `Storage: ${skillMeshPaths().root}`,
    `Default node: ${nodes[0]?.url || "(none)"}`,
    "Sharing model: signed reviewed skill packs only; no raw chats, sessions, project files, .env files, cookies, or artifacts.",
    "Community imports are installed disabled by default until explicitly enabled.",
  ].join("\n");
}

function ensureSkillMeshDb(indexDbPath) {
  fsSync.mkdirSync(path.dirname(indexDbPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(indexDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS packs (
      pack_hash TEXT PRIMARY KEY,
      canonical_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      author_key_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      value_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS installed_packs (
      pack_hash TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      installed_at TEXT NOT NULL,
      source_feed TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS rejected_packs (
      pack_hash TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      rejected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verified_nodes (
      node_id TEXT PRIMARY KEY,
      public_url TEXT NOT NULL,
      role TEXT NOT NULL,
      protocol INTEGER NOT NULL,
      status TEXT NOT NULL,
      first_verified_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL
    );
  `);
  return db;
}

function openSkillMeshDb(home = agintiflowHome()) {
  const paths = skillMeshPaths(home);
  return ensureSkillMeshDb(paths.indexDbPath);
}

function safeSkillId(id = "") {
  const text = String(id || "").trim();
  return SAFE_ID_PATTERN.test(text) ? text : "";
}

function assertSafePath(relativePath = "") {
  const normalized = path.posix.normalize(String(relativePath || "").replace(/\\/g, "/"));
  if (!normalized || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/../")) {
    throw new Error(`Unsafe pack path: ${relativePath}`);
  }
  const lower = normalized.toLowerCase();
  for (const forbidden of FORBIDDEN_PATH_PARTS) {
    if (lower === forbidden || lower.includes(`/${forbidden}`) || lower.includes(`${forbidden}/`)) {
      throw new Error(`Forbidden private path in pack: ${relativePath}`);
    }
  }
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalSkillContent(content = "") {
  return String(content || "").replace(/\r\n/g, "\n").trim();
}

function canonicalPackForSignature(pack) {
  const copy = { ...pack };
  delete copy.signature;
  delete copy.packHash;
  return copy;
}

function canonicalPackId(skills = []) {
  const semantic = skills.map((skill) => ({ id: skill.id, hash: skill.hash })).sort((a, b) => a.id.localeCompare(b.id));
  return `skillpack:${sha256(stableStringify(semantic)).slice(0, 24)}`;
}

async function ensureIdentity(home = agintiflowHome()) {
  const paths = await ensureSkillMeshHome(home);
  const loaded = await readJson(paths.identityPath, null);
  if (loaded?.privateKey && loaded?.publicKey && loaded?.keyId) return loaded;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const identity = {
    createdAt: nowIso(),
    keyId: `ed25519:${sha256(publicPem).slice(0, 24)}`,
    publicKey: publicPem,
    privateKey: privatePem,
  };
  await writeJson(paths.identityPath, identity);
  await fs.chmod(paths.identityPath, 0o600).catch(() => {});
  return identity;
}

function signPack(pack, identity) {
  const payload = Buffer.from(stableStringify(canonicalPackForSignature(pack)));
  const privateKey = crypto.createPrivateKey(identity.privateKey);
  const signature = crypto.sign(null, payload, privateKey).toString("base64");
  return {
    algorithm: "ed25519",
    keyId: identity.keyId,
    publicKey: identity.publicKey,
    value: signature,
  };
}

function verifyPackSignature(pack) {
  const signature = pack?.signature;
  if (!signature?.publicKey || !signature?.value || signature.algorithm !== "ed25519") {
    return { ok: false, reason: "missing or unsupported signature" };
  }
  try {
    const publicKey = crypto.createPublicKey(signature.publicKey);
    const payload = Buffer.from(stableStringify(canonicalPackForSignature(pack)));
    const ok = crypto.verify(null, payload, publicKey, Buffer.from(signature.value, "base64"));
    const expectedKeyId = `ed25519:${sha256(signature.publicKey).slice(0, 24)}`;
    if (!ok) return { ok: false, reason: "signature verification failed" };
    if (signature.keyId && signature.keyId !== expectedKeyId) return { ok: false, reason: "signature key id mismatch" };
    return { ok: true, keyId: expectedKeyId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function validateSkillMarkdownContent(content = "", context = "SKILL.md") {
  const text = String(content || "");
  if (!text.trim()) throw new Error(`${context}: empty skill`);
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) throw new Error(`${context}: skill is too large`);
  if (redactSensitiveText(text) !== text) throw new Error(`${context}: contains token-like secret text`);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${context}: missing YAML frontmatter`);
  const frontmatter = match[1];
  const fields = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!scalar) continue;
    const value = scalar[2].trim().replace(/^['"]|['"]$/g, "");
    if (value) fields[scalar[1]] = value;
  }
  for (const field of ["id", "label", "description"]) {
    if (!fields[field]) throw new Error(`${context}: ${field} is required`);
  }
  if (!safeSkillId(fields.id)) throw new Error(`${context}: invalid skill id ${fields.id}`);
  return fields;
}

function builtInSkillIds() {
  return new Set(listSkills({ includeBody: false, includeSkillMesh: false }).map((skill) => skill.id));
}

export async function buildSkillPack(skillId, { home = agintiflowHome(), author = "local-user", valueScore = 80 } = {}) {
  const id = safeSkillId(skillId);
  if (!id) throw new Error(`Invalid skill id: ${skillId}`);
  const skills = listSkills({ includeBody: false });
  const skill = skills.find((item) => item.id === id);
  if (!skill?.path) throw new Error(`Skill not found: ${id}`);
  const content = await fs.readFile(skill.path, "utf8");
  return buildSkillPackFromMarkdown(content, { home, author, valueScore });
}

export async function buildSkillPackFromMarkdown(content, { home = agintiflowHome(), author = "local-user", valueScore = 80 } = {}) {
  const fields = validateSkillMarkdownContent(content, "SKILL.md");
  const id = fields.id;
  const normalized = canonicalSkillContent(content);
  const entry = {
    id,
    path: `skills/${id}/SKILL.md`,
    content: normalized,
    hash: `sha256:${sha256(normalized)}`,
  };
  const identity = await ensureIdentity(home);
  const pack = {
    schema: 1,
    kind: "agintiflow-skillpack",
    protocol: PROTOCOL_VERSION,
    name: id,
    version: "0.1.0",
    author,
    license: "Apache-2.0",
    createdAt: nowIso(),
    authorKeyId: identity.keyId,
    source: "reviewed-local-learning",
    privacy: {
      rawSessionsIncluded: false,
      secretsRedacted: true,
      pathsMasked: true,
      requiresHumanReview: true,
    },
    valueScore: Number(valueScore) || 80,
    contents: { skills: [id], profiles: [], policies: [], tests: [] },
    skills: [entry],
  };
  pack.canonicalId = canonicalPackId(pack.skills);
  pack.signature = signPack(pack, identity);
  pack.packHash = `sha256:${sha256(stableStringify(canonicalPackForHash(pack)))}`;
  return pack;
}

function canonicalPackForHash(pack) {
  const copy = { ...pack };
  delete copy.packHash;
  return copy;
}

export function validateSkillPack(pack, { requireSignature = true, allowBuiltInOverride = false } = {}) {
  const errors = [];
  const normalized = pack && typeof pack === "object" ? pack : null;
  if (!normalized) throw new Error("Skill pack must be a JSON object");
  if (normalized.schema !== 1 || normalized.kind !== "agintiflow-skillpack") errors.push("unsupported skill pack schema");
  if (normalized.protocol && Number(normalized.protocol) !== PROTOCOL_VERSION) errors.push("unsupported protocol version");
  if (!normalized.privacy || normalized.privacy.rawSessionsIncluded !== false) errors.push("privacy.rawSessionsIncluded must be false");
  if (normalized.privacy?.secretsRedacted !== true) errors.push("privacy.secretsRedacted must be true");
  if (normalized.privacy?.requiresHumanReview !== true) errors.push("privacy.requiresHumanReview must be true");
  const skills = Array.isArray(normalized.skills) ? normalized.skills : [];
  if (skills.length < 1 || skills.length > MAX_SKILLS_PER_PACK) errors.push(`pack must include 1-${MAX_SKILLS_PER_PACK} skills`);
  const coreIds = builtInSkillIds();
  for (const skill of skills) {
    const id = safeSkillId(skill?.id);
    if (!id) {
      errors.push(`invalid skill id: ${skill?.id || ""}`);
      continue;
    }
    if (!allowBuiltInOverride && coreIds.has(id)) errors.push(`pack cannot override built-in skill: ${id}`);
    try {
      assertSafePath(skill.path || `skills/${id}/SKILL.md`);
      const fields = validateSkillMarkdownContent(skill.content || "", skill.path || id);
      if (fields.id !== id) errors.push(`skill frontmatter id mismatch for ${id}`);
      const expectedHash = `sha256:${sha256(canonicalSkillContent(skill.content || ""))}`;
      if (skill.hash && skill.hash !== expectedHash) errors.push(`skill hash mismatch for ${id}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const signature = verifyPackSignature(normalized);
  if (requireSignature && !signature.ok) errors.push(signature.reason);
  const computedHash = `sha256:${sha256(stableStringify(canonicalPackForHash(normalized)))}`;
  if (normalized.packHash && normalized.packHash !== computedHash) {
    // Older local packs may omit this exact form; treat mismatch as a hard error only if contents are otherwise suspicious.
    errors.push("pack hash mismatch");
  }
  if (redactSensitiveText(stableStringify(normalized)) !== stableStringify(normalized)) {
    errors.push("pack contains token-like secret text");
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_PACK_BYTES) errors.push("pack is too large");
  if (errors.length) throw new Error(errors.join("; "));
  return {
    ok: true,
    keyId: signature.keyId || normalized.authorKeyId || "",
    packHash: normalized.packHash || computedHash,
    canonicalId: normalized.canonicalId || canonicalPackId(skills),
  };
}

function packMetadata(pack, validation = null, overrides = {}) {
  const checked = validation || validateSkillPack(pack, { allowBuiltInOverride: true });
  return {
    packHash: checked.packHash,
    canonicalId: checked.canonicalId,
    name: pack.name || pack.contents?.skills?.[0] || "skillpack",
    version: pack.version || "0.1.0",
    authorKeyId: checked.keyId || pack.authorKeyId || "",
    trustLevel: overrides.trustLevel || pack.trustLevel || "community-reviewed",
    valueScore: Number(overrides.valueScore ?? pack.valueScore ?? 80) || 80,
    status: overrides.status || pack.status || "approved",
    createdAt: pack.createdAt || nowIso(),
    skills: pack.contents?.skills || pack.skills?.map((skill) => skill.id) || [],
    signatureKeyId: pack.signature?.keyId || "",
  };
}

function upsertPackRecord(db, metadata, status = metadata.status || "approved") {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO packs (
      pack_hash, canonical_id, name, version, author_key_id, status, trust_level, value_score,
      created_at, received_at, last_seen_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pack_hash) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      status = CASE WHEN excluded.status != '' THEN excluded.status ELSE packs.status END,
      metadata_json = excluded.metadata_json`
  ).run(
    metadata.packHash,
    metadata.canonicalId,
    metadata.name,
    metadata.version,
    metadata.authorKeyId,
    status,
    metadata.trustLevel,
    metadata.valueScore,
    metadata.createdAt,
    timestamp,
    timestamp,
    JSON.stringify(metadata)
  );
}

export async function exportSkillPack(skillId, { outPath = "", home = agintiflowHome() } = {}) {
  const paths = await ensureSkillMeshHome(home);
  const pack = await buildSkillPack(skillId, { home });
  const target = outPath || path.join(paths.reviewedDir, `${pack.name}.skillpack.json`);
  await writeJson(target, pack);
  const db = openSkillMeshDb(home);
  const metadata = packMetadata(pack, validateSkillPack(pack, { allowBuiltInOverride: true }), {
    trustLevel: "local-reviewed",
    status: "reviewed",
  });
  upsertPackRecord(db, metadata, "reviewed");
  return { pack, path: target, metadata };
}

export async function importSkillPack(inputPath, { home = agintiflowHome(), enabled = false, sourceFeed = "" } = {}) {
  const paths = await ensureSkillMeshHome(home);
  const text = await fs.readFile(inputPath, "utf8");
  const pack = JSON.parse(text);
  return installSkillPack(pack, { home, enabled, sourceFeed });
}

export async function installSkillPack(pack, { home = agintiflowHome(), enabled = false, sourceFeed = "" } = {}) {
  const paths = await ensureSkillMeshHome(home);
  const validation = validateSkillPack(pack);
  const db = openSkillMeshDb(home);
  const metadata = packMetadata(pack, validation, {
    trustLevel: sourceFeed ? "community-reviewed" : "local-reviewed",
    status: "installed",
  });
  for (const skill of pack.skills || []) {
    const id = safeSkillId(skill.id);
    if (!id) throw new Error(`Invalid skill id: ${skill.id}`);
    const skillDir = path.join(paths.skillsDir, id);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), `${canonicalSkillContent(skill.content)}\n`, "utf8");
    await writeJson(path.join(skillDir, "skillmesh.json"), {
      installedAt: nowIso(),
      enabled: Boolean(enabled),
      sourceFeed,
      packHash: validation.packHash,
      canonicalId: validation.canonicalId,
      trustLevel: metadata.trustLevel,
    });
  }
  const safeHashName = validation.packHash.replace(/[^A-Za-z0-9._-]/g, "-");
  await writeJson(path.join(paths.packsDir, `${safeHashName}.json`), pack);
  upsertPackRecord(db, metadata, "installed");
  db.prepare(
    `INSERT INTO installed_packs (pack_hash, enabled, installed_at, source_feed)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pack_hash) DO UPDATE SET enabled = excluded.enabled, source_feed = excluded.source_feed`
  ).run(validation.packHash, enabled ? 1 : 0, nowIso(), sourceFeed || "");
  return { packHash: validation.packHash, canonicalId: validation.canonicalId, installedSkills: pack.skills.map((skill) => skill.id), enabled };
}

export async function enableSkillMeshSkill(skillId, enabled = true, home = agintiflowHome()) {
  const id = safeSkillId(skillId);
  if (!id) throw new Error(`Invalid skill id: ${skillId}`);
  const paths = await ensureSkillMeshHome(home);
  const metadataPath = path.join(paths.skillsDir, id, "skillmesh.json");
  const metadata = await readJson(metadataPath, null);
  if (!metadata) throw new Error(`Skill Mesh skill not installed: ${id}`);
  metadata.enabled = Boolean(enabled);
  metadata.updatedAt = nowIso();
  await writeJson(metadataPath, metadata);
  const db = openSkillMeshDb(home);
  if (metadata.packHash) {
    db.prepare("UPDATE installed_packs SET enabled = ? WHERE pack_hash = ?").run(enabled ? 1 : 0, metadata.packHash);
  }
  return metadata;
}

export async function listInstalledSkillMeshSkills({ home = agintiflowHome() } = {}) {
  const paths = await ensureSkillMeshHome(home);
  const entries = await fs.readdir(paths.skillsDir, { withFileTypes: true }).catch(() => []);
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(paths.skillsDir, entry.name, "SKILL.md");
    const metadata = await readJson(path.join(paths.skillsDir, entry.name, "skillmesh.json"), {});
    try {
      const skill = loadSkillFile(skillPath);
      delete skill.body;
      skills.push({ ...skill, skillmesh: metadata });
    } catch {
      // Skip invalid community skills; validation should have caught these before install.
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchJson(url, { method = "GET", body = null, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "user-agent": "AgInTiFlow-SkillMesh/1" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = {};
    if (text) json = JSON.parse(text);
    if (!response.ok) throw new Error(json.error || `${response.status} ${response.statusText}`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export async function submitSkillPack(pack, nodeUrl, { timeoutMs = 10000 } = {}) {
  const url = `${normalizeUrl(nodeUrl)}/submit`;
  validateSkillPack(pack, { allowBuiltInOverride: true });
  return fetchJson(url, { method: "POST", body: pack, timeoutMs });
}

function localKnownPacks(home = agintiflowHome()) {
  const db = openSkillMeshDb(home);
  const rows = db.prepare("SELECT pack_hash AS packHash, canonical_id AS canonicalId FROM packs").all();
  return {
    hashes: rows.map((row) => row.packHash).filter(Boolean),
    canonicalIds: rows.map((row) => row.canonicalId).filter(Boolean),
  };
}

export async function syncSkillMesh({ nodeUrl = "", home = agintiflowHome(), install = false, limit = 20 } = {}) {
  const config = await loadSkillMeshConfig(home);
  if (config.mode !== "share") return { ok: true, skipped: true, reason: `Skill Mesh mode is ${config.mode}` };
  const node =
    nodeUrl ||
    normalizeUrl((config.nodes || []).find((item) => item.enabled !== false)?.url || "") ||
    DEFAULT_NODE_URL;
  if (!node) return { ok: true, skipped: true, reason: "No enabled Skill Mesh node configured" };
  const known = localKnownPacks(home);
  let metadata;
  try {
    metadata = await fetchJson(`${normalizeUrl(node)}/sync/metadata`, {
      method: "POST",
      body: {
        clientProtocol: PROTOCOL_VERSION,
        knownPackHashes: known.hashes.slice(0, 1000),
        knownCanonicalIds: known.canonicalIds.slice(0, 1000),
        acceptedTrustLevels: ["core", "trusted-publisher", "community-reviewed", "local-reviewed"],
      },
    });
  } catch (error) {
    return { ok: true, skipped: true, unreachable: true, node, reason: error instanceof Error ? error.message : String(error) };
  }
  const packs = Array.isArray(metadata.packs) ? metadata.packs.slice(0, Math.min(limit, config.syncPolicy.maxInboundPacksPerSync || 20)) : [];
  const downloaded = [];
  if (install) {
    for (const item of packs) {
      if (!item.downloadUrl) continue;
      const packUrl = item.downloadUrl.startsWith("http") ? item.downloadUrl : `${normalizeUrl(node)}${item.downloadUrl}`;
      const pack = await fetchJson(packUrl, { timeoutMs: 10000 });
      const result = await installSkillPack(pack, { home, enabled: false, sourceFeed: normalizeUrl(node) });
      downloaded.push(result);
    }
  }
  config.syncPolicy.lastSyncAt = nowIso();
  await saveSkillMeshConfig(config, home);
  return { ok: true, node: normalizeUrl(node), available: packs.length, packs, downloaded };
}

function feedRows(db, publicUrl = "") {
  const rows = db
    .prepare(
      `SELECT pack_hash AS packHash, canonical_id AS canonicalId, name, version, author_key_id AS authorKeyId,
        trust_level AS trustLevel, value_score AS valueScore, status, created_at AS createdAt, metadata_json AS metadataJson
       FROM packs
       WHERE status IN ('approved', 'reviewed', 'installed')
       ORDER BY value_score DESC, created_at DESC
       LIMIT ?`
    )
    .all(MAX_FEED_PACKS);
  return rows.map((row) => {
    const safeHashName = row.packHash.replace(/[^A-Za-z0-9._-]/g, "-");
    return {
      packHash: row.packHash,
      canonicalId: row.canonicalId,
      name: row.name,
      version: row.version,
      authorKeyId: row.authorKeyId,
      trustLevel: row.trustLevel,
      valueScore: row.valueScore,
      status: row.status,
      createdAt: row.createdAt,
      downloadUrl: `${publicUrl || ""}/packs/${safeHashName}.json`,
      metadataUrl: `${publicUrl || ""}/packs/${safeHashName}/metadata.json`,
    };
  });
}

function nodeRows(db, self = {}) {
  const rows = db
    .prepare(
      `SELECT node_id AS nodeId, public_url AS publicUrl, role, protocol, status,
        first_verified_at AS firstVerifiedAt, last_verified_at AS lastVerifiedAt,
        last_seen_at AS lastSeenAt, failure_count AS failureCount, metadata_json AS metadataJson
       FROM verified_nodes
       WHERE status IN ('verified', 'degraded')
       ORDER BY last_verified_at DESC
       LIMIT 100`
    )
    .all();
  const nodes = rows.map((row) => ({
    nodeId: row.nodeId,
    publicUrl: row.publicUrl,
    role: row.role,
    protocol: row.protocol,
    status: row.status,
    firstVerifiedAt: row.firstVerifiedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    lastSeenAt: row.lastSeenAt,
    failureCount: row.failureCount,
  }));
  if (self.publicUrl) {
    nodes.unshift({
      nodeId: self.nodeId || "self",
      publicUrl: self.publicUrl,
      role: self.role || "major",
      protocol: PROTOCOL_VERSION,
      status: "verified",
      self: true,
    });
  }
  return nodes;
}

function relayPaths(dataDir) {
  const root = path.resolve(dataDir || path.join(process.cwd(), ".aginti-skill-relay"));
  return {
    root,
    indexDbPath: path.join(root, "index.sqlite"),
    packsDir: path.join(root, "packs"),
    logsDir: path.join(root, "logs"),
  };
}

function openRelayDb(paths) {
  const db = ensureSkillMeshDb(paths.indexDbPath);
  return db;
}

async function saveRelayPack(paths, pack, validation, metadata) {
  await fs.mkdir(paths.packsDir, { recursive: true });
  const safeHashName = validation.packHash.replace(/[^A-Za-z0-9._-]/g, "-");
  await writeJson(path.join(paths.packsDir, `${safeHashName}.json`), pack);
  await writeJson(path.join(paths.packsDir, `${safeHashName}.metadata.json`), metadata);
}

export async function startSkillMeshRelay({
  host = "127.0.0.1",
  port = 7377,
  dataDir = "",
  publicUrl = "",
  role = "major",
  acceptUploads = true,
} = {}) {
  const paths = relayPaths(dataDir);
  await fs.mkdir(paths.packsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  const db = openRelayDb(paths);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: `${MAX_PACK_BYTES}b`, strict: true }));

  app.get("/health", (request, response) => {
    response.json({
      ok: true,
      service: "agintiflow-skillmesh",
      role,
      protocol: PROTOCOL_VERSION,
      time: nowIso(),
      nonce: request.query.nonce || "",
      publicUrl: normalizeUrl(publicUrl),
      acceptsRawSessions: false,
      acceptUploads: Boolean(acceptUploads),
    });
  });

  app.get("/feed.json", (_request, response) => {
    response.json({
      feedVersion: PROTOCOL_VERSION,
      generatedAt: nowIso(),
      role,
      publicUrl: normalizeUrl(publicUrl),
      syncPolicy: { slowSync: true, metadataFirst: true },
      packs: feedRows(db, normalizeUrl(publicUrl)),
      nodesUrl: `${normalizeUrl(publicUrl) || ""}/nodes.json`,
    });
  });

  app.get("/nodes.json", (_request, response) => {
    response.json({
      protocol: PROTOCOL_VERSION,
      generatedAt: nowIso(),
      role,
      nodes: nodeRows(db, { publicUrl: normalizeUrl(publicUrl), role, nodeId: "local-relay" }),
    });
  });

  app.post("/sync/metadata", (request, response) => {
    const knownHashes = new Set(Array.isArray(request.body?.knownPackHashes) ? request.body.knownPackHashes : []);
    const knownCanonicalIds = new Set(Array.isArray(request.body?.knownCanonicalIds) ? request.body.knownCanonicalIds : []);
    const acceptedTrustLevels = new Set(
      Array.isArray(request.body?.acceptedTrustLevels) && request.body.acceptedTrustLevels.length
        ? request.body.acceptedTrustLevels
        : ["community-reviewed", "trusted-publisher", "core"]
    );
    const packs = feedRows(db, normalizeUrl(publicUrl)).filter(
      (pack) => !knownHashes.has(pack.packHash) && !knownCanonicalIds.has(pack.canonicalId) && acceptedTrustLevels.has(pack.trustLevel)
    );
    response.json({ feedVersion: PROTOCOL_VERSION, generatedAt: nowIso(), packs });
  });

  app.post("/submit", async (request, response) => {
    if (!acceptUploads) {
      response.status(403).json({ ok: false, error: "uploads disabled" });
      return;
    }
    try {
      const pack = request.body;
      const validation = validateSkillPack(pack, { requireSignature: true });
      const metadata = packMetadata(pack, validation, {
        trustLevel: "community-reviewed",
        status: "approved",
      });
      upsertPackRecord(db, metadata, "approved");
      await saveRelayPack(paths, pack, validation, metadata);
      response.json({ ok: true, packHash: validation.packHash, canonicalId: validation.canonicalId, status: "approved" });
    } catch (error) {
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/packs/:hash.json", async (request, response) => {
    const safeHashName = String(request.params.hash || "").replace(/[^A-Za-z0-9._-]/g, "");
    const filePath = path.join(paths.packsDir, `${safeHashName}.json`);
    try {
      response.type("application/json").send(await fs.readFile(filePath, "utf8"));
    } catch {
      response.status(404).json({ ok: false, error: "pack not found" });
    }
  });

  app.get("/packs/:hash/metadata.json", async (request, response) => {
    const safeHashName = String(request.params.hash || "").replace(/[^A-Za-z0-9._-]/g, "");
    const filePath = path.join(paths.packsDir, `${safeHashName}.metadata.json`);
    try {
      response.type("application/json").send(await fs.readFile(filePath, "utf8"));
    } catch {
      response.status(404).json({ ok: false, error: "metadata not found" });
    }
  });

  app.use((error, _request, response, _next) => {
    response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(Number(port), host, resolve));
  return {
    app,
    server,
    url: `http://${host}:${server.address().port}`,
    paths,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function expandHome(value = "") {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function currentUserName() {
  return process.env.SUDO_USER || process.env.USER || os.userInfo().username || "aginti-relay";
}

function servicePaths({ dataDir = "", name = DEFAULT_SERVICE_NAME } = {}) {
  const root = path.resolve(expandHome(dataDir || "~/.aginti-skill-relay"));
  return {
    dataDir: root,
    runScript: path.join(root, `${name}.run.sh`),
    logDir: path.join(root, "logs"),
  };
}

function relayServeArgs({ host = "127.0.0.1", port = 7377, dataDir = "", publicUrl = "", role = "major", noUploads = false } = {}) {
  const args = [
    process.execPath,
    path.join(PACKAGE_ROOT, "bin", "aginti-cli.js"),
    "skillmesh",
    "serve",
    "--role",
    role,
    "--host",
    host,
    "--port",
    String(port),
    "--data",
    path.resolve(expandHome(dataDir || "~/.aginti-skill-relay")),
  ];
  if (publicUrl) args.push("--public-url", publicUrl);
  if (noUploads) args.push("--no-uploads");
  return args;
}

export function buildSkillMeshServiceUnit({
  name = DEFAULT_SERVICE_NAME,
  user = currentUserName(),
  dataDir = "",
  runScript = "",
  scope = "system",
} = {}) {
  const paths = servicePaths({ dataDir, name });
  const script = runScript || paths.runScript;
  const lines = [
    "[Unit]",
    "Description=AgInTi Skill Mesh Relay",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
  ];
  if (scope === "system") {
    lines.push(`User=${user}`);
  }
  lines.push(
    `WorkingDirectory=${paths.dataDir}`,
    "Environment=NODE_ENV=production",
    `ExecStart=${script}`,
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    `ReadWritePaths=${paths.dataDir}`,
    "",
    "[Install]",
    scope === "system" ? "WantedBy=multi-user.target" : "WantedBy=default.target",
    ""
  );
  return lines.join("\n");
}

async function writeRelayRunScript(options = {}) {
  const name = options.name || DEFAULT_SERVICE_NAME;
  const paths = servicePaths({ dataDir: options.dataDir, name });
  await fs.mkdir(paths.logDir, { recursive: true });
  const args = relayServeArgs({ ...options, dataDir: paths.dataDir });
  const logPath = path.join(paths.logDir, "relay.log");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `mkdir -p ${shellQuote(paths.logDir)}`,
    `exec ${args.map(shellQuote).join(" ")} 2>&1 | tee -a ${shellQuote(logPath)}`,
    "",
  ].join("\n");
  await fs.writeFile(paths.runScript, script, "utf8");
  await fs.chmod(paths.runScript, 0o755);
  return { ...paths, runScript: paths.runScript, logPath };
}

function runCommand(command, args = [], { input = undefined, stdio = "pipe" } = {}) {
  return execFileSync(command, args, {
    input,
    encoding: "utf8",
    stdio: input === undefined ? stdio : ["pipe", "pipe", "pipe"],
  });
}

function runSudo(args = [], { input = undefined } = {}) {
  return runCommand("sudo", ["-n", ...args], { input });
}

function systemctl(scope = "system", args = []) {
  return scope === "user" ? runCommand("systemctl", ["--user", ...args]) : runSudo(["systemctl", ...args]);
}

function serviceNameFromOptions(options = {}) {
  const name = String(options.name || DEFAULT_SERVICE_NAME).trim();
  if (!/^[A-Za-z0-9_.@-]+$/.test(name)) throw new Error(`Invalid service name: ${name}`);
  return name.endsWith(".service") ? name.slice(0, -8) : name;
}

export async function installSkillMeshService(options = {}) {
  if (process.platform !== "linux") {
    throw new Error("Skill Mesh service install currently supports Linux systemd. Use a process manager on this OS.");
  }
  const scope = options.user ? "user" : "system";
  const name = serviceNameFromOptions(options);
  const serviceFile = `${name}.service`;
  const paths = await writeRelayRunScript({ ...options, name });
  const unit = buildSkillMeshServiceUnit({
    name,
    user: options.serviceUser || currentUserName(),
    dataDir: paths.dataDir,
    runScript: paths.runScript,
    scope,
  });
  if (scope === "user") {
    const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
    const unitPath = path.join(unitDir, serviceFile);
    await fs.mkdir(unitDir, { recursive: true });
    await fs.writeFile(unitPath, unit, "utf8");
    runCommand("systemctl", ["--user", "daemon-reload"]);
    runCommand("systemctl", ["--user", "enable", "--now", serviceFile]);
    if (options.linger) {
      try {
        runSudo(["loginctl", "enable-linger", currentUserName()]);
      } catch {
        // Linger is optional; status output tells the user how to enable boot persistence.
      }
    }
    return { scope, serviceFile, unitPath, ...paths };
  }
  const unitPath = `/etc/systemd/system/${serviceFile}`;
  runSudo(["tee", unitPath], { input: unit });
  runSudo(["systemctl", "daemon-reload"]);
  runSudo(["systemctl", "enable", "--now", serviceFile]);
  return { scope, serviceFile, unitPath, ...paths };
}

export async function manageSkillMeshService(action = "status", options = {}) {
  const scope = options.user ? "user" : "system";
  const name = serviceNameFromOptions(options);
  const serviceFile = `${name}.service`;
  if (action === "install") return installSkillMeshService(options);
  if (action === "uninstall" || action === "remove") {
    try {
      systemctl(scope, ["disable", "--now", serviceFile]);
    } catch {
      // Continue removing unit files even if the service is already absent.
    }
    if (scope === "user") {
      await fs.rm(path.join(os.homedir(), ".config", "systemd", "user", serviceFile), { force: true });
      runCommand("systemctl", ["--user", "daemon-reload"]);
    } else {
      runSudo(["rm", "-f", `/etc/systemd/system/${serviceFile}`]);
      runSudo(["systemctl", "daemon-reload"]);
    }
    return { scope, serviceFile, removed: true };
  }
  if (["start", "stop", "restart", "enable", "disable"].includes(action)) {
    systemctl(scope, [action, action === "enable" || action === "disable" ? "--now" : "", serviceFile].filter(Boolean));
    return { scope, serviceFile, action };
  }
  const output = systemctl(scope, ["status", "--no-pager", serviceFile]);
  return { scope, serviceFile, status: output };
}

function parseCliOptions(argv = []) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const key = arg.replace(/^--/, "");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return options;
}

export async function handleSkillMeshCommand(argv = []) {
  const command = String(argv[0] || "status").toLowerCase();
  const options = parseCliOptions(argv.slice(1));
  if (["status", "show", ""].includes(command)) {
    const config = await loadSkillMeshConfig();
    console.log(formatSkillMeshStatus(config));
    const skills = await listInstalledSkillMeshSkills();
    if (skills.length) {
      console.log("");
      console.log("Installed Skill Mesh skills:");
      for (const skill of skills) {
        console.log(`  ${skill.skillmesh?.enabled ? "enabled " : "disabled"} ${skill.id}: ${skill.label}`);
      }
    }
    return;
  }
  if (["off", "disable", "disabled", "record", "local", "share", "on"].includes(command)) {
    const config = await setSkillMeshMode(command);
    console.log(formatSkillMeshStatus(config));
    return;
  }
  if (command === "nodes") {
    const config = await loadSkillMeshConfig();
    if (options.remote) {
      const nodeUrl = options.node || (config.nodes || []).find((node) => node.enabled !== false)?.url || DEFAULT_NODE_URL;
      try {
        const remote = await fetchJson(`${normalizeUrl(nodeUrl)}/nodes.json`);
        for (const node of remote.nodes || []) {
          console.log(`${node.status || "unknown"} ${node.role || "node"} ${node.publicUrl}`);
        }
      } catch (error) {
        console.log(`remote node list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    for (const node of config.nodes || []) console.log(`${node.enabled === false ? "disabled" : "enabled "} ${node.name || "node"} ${node.url}`);
    return;
  }
  if (command === "node") {
    const action = String(options._[0] || "").toLowerCase();
    if (action === "add") {
      const node = await addSkillMeshNode(options._[1], options._[2], { role: options.role || "volunteer" });
      console.log(`added node ${node.name} ${node.url}`);
      return;
    }
    if (action === "remove" || action === "rm") {
      const removed = await removeSkillMeshNode(options._[1]);
      console.log(`removed=${removed}`);
      return;
    }
    throw new Error("Usage: aginti skillmesh node add <name> <url> OR aginti skillmesh node remove <name-or-url>");
  }
  if (command === "service") {
    const action = String(options._[0] || "status").toLowerCase();
    const serviceOptions = {
      name: options.name || DEFAULT_SERVICE_NAME,
      user: Boolean(options.user),
      linger: Boolean(options.linger),
      serviceUser: options["service-user"] || currentUserName(),
      host: options.host || "127.0.0.1",
      port: Number(options.port || 7377),
      dataDir: options.data || "~/.aginti-skill-relay",
      publicUrl: options["public-url"] || "",
      role: options.role || "major",
      noUploads: Boolean(options["no-uploads"]),
    };
    const result = await manageSkillMeshService(action, serviceOptions);
    if (action === "status") {
      console.log(result.status || `${result.serviceFile} status unavailable`);
      return;
    }
    if (action === "install") {
      console.log(`installed ${result.scope} service ${result.serviceFile}`);
      console.log(`unit=${result.unitPath}`);
      console.log(`run=${result.runScript}`);
      console.log(`data=${result.dataDir}`);
      if (result.scope === "user") {
        console.log("For reboot persistence of a user service, enable linger: sudo loginctl enable-linger $(whoami)");
      }
      return;
    }
    console.log(`${action} ${result.scope} service ${result.serviceFile}`);
    return;
  }
  if (command === "export") {
    const skillId = options._[0] || "";
    if (!skillId) throw new Error("Usage: aginti skillmesh export <skill-id> [--out file.skillpack.json]");
    const result = await exportSkillPack(skillId, { outPath: options.out || "" });
    console.log(`exported ${skillId}`);
    console.log(`pack=${result.path}`);
    console.log(`hash=${result.metadata.packHash}`);
    return;
  }
  if (command === "import") {
    const inputPath = options._[0] || "";
    if (!inputPath) throw new Error("Usage: aginti skillmesh import <file.skillpack.json> [--enable]");
    const result = await importSkillPack(inputPath, { enabled: Boolean(options.enable) });
    console.log(`imported ${result.installedSkills.join(", ")} enabled=${result.enabled}`);
    console.log(`hash=${result.packHash}`);
    return;
  }
  if (command === "enable" || command === "disable-skill") {
    const skillId = options._[0] || "";
    if (!skillId) throw new Error(`Usage: aginti skillmesh ${command} <skill-id>`);
    const metadata = await enableSkillMeshSkill(skillId, command === "enable");
    console.log(`${command === "enable" ? "enabled" : "disabled"} ${skillId} pack=${metadata.packHash || ""}`);
    return;
  }
  if (command === "sync") {
    const result = await syncSkillMesh({ nodeUrl: options.node || "", install: Boolean(options.install) });
    if (result.skipped) {
      console.log(`Skill Mesh sync skipped: ${result.reason}`);
      if (result.node) console.log(`node=${result.node}`);
      return;
    }
    console.log(`Skill Mesh sync node=${result.node} available=${result.available} downloaded=${result.downloaded?.length || 0}`);
    for (const pack of result.packs || []) console.log(`  ${pack.name} ${pack.packHash} ${pack.trustLevel}`);
    return;
  }
  if (command === "submit") {
    const inputPath = options._[0] || "";
    if (!inputPath) throw new Error("Usage: aginti skillmesh submit <file.skillpack.json> [--node URL]");
    const pack = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const config = await loadSkillMeshConfig();
    const nodeUrl = options.node || (config.nodes || []).find((node) => node.enabled !== false)?.url || DEFAULT_NODE_URL;
    const result = await submitSkillPack(pack, nodeUrl);
    console.log(`submitted ${result.packHash} status=${result.status}`);
    return;
  }
  if (command === "serve") {
    const relay = await startSkillMeshRelay({
      host: options.host || "127.0.0.1",
      port: Number(options.port || 7377),
      dataDir: options.data || "",
      publicUrl: options["public-url"] || "",
      role: options.role || "major",
      acceptUploads: options["no-uploads"] ? false : true,
    });
    console.log(`AgInTi Skill Mesh relay listening at ${relay.url}`);
    console.log(`data=${relay.paths.root}`);
    await new Promise(() => {});
    return;
  }
  throw new Error(
    "Usage: aginti skillmesh [status|off|record|share|nodes|node|service|export|import|enable|disable-skill|sync|submit|serve]"
  );
}
