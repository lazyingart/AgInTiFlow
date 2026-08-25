import { types as utilTypes } from "node:util";

import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_ARTIFACT_KINDS,
  INTEGRATION_MAXIMUM_SEARCH_SOURCES,
  INTEGRATION_SEARCH_ARTIFACT_KIND,
  IntegrationValidationError,
  contractDigest,
  integrationBoundedText,
  integrationExactKeys,
  integrationInvalid,
  validateIntegrationArtifactId,
} from "./integration-policy.js";
import { redactSensitiveText } from "./redaction.js";

export const MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES = 48 * 1024;
export const MAX_INTEGRATION_FILE_ARTIFACT_BYTES = 16 * 1024 * 1024;

const PLOT_TYPES = new Set(["line", "bar", "scatter", "area"]);
const MAX_PLOT_MAGNITUDE = Number.MAX_SAFE_INTEGER;
const CREDENTIAL_QUERY_NAME =
  /(?:(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|key|password|secret|signature|token)(?:$|[_-])|^(?:(?:aws|google)?accesskeyid|googleaccessid|sig)$)/iu;
const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/[^\s"'`<>)\]]*)?|[A-Za-z]:\\[^\s"'`<>)\]]*)/giu;

function stableArtifactId(...parts) {
  return `art_${contractDigest(parts).slice(0, 64)}`;
}

function redactPublicText(value) {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const prefix = /^[\s("'`]/u.test(match) ? match[0] : "";
    return `${prefix}[REDACTED_PATH]`;
  });
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) integrationInvalid(`${label} must be a finite number`);
  return value;
}

function plotNumber(value, label) {
  const normalized = finiteNumber(value, label);
  if (Math.abs(normalized) > MAX_PLOT_MAGNITUDE) integrationInvalid(`${label} exceeds the supported plot magnitude`);
  return normalized;
}

function validatePlotRange(values, label, { includeZero = false } = {}) {
  let minimum = includeZero ? Math.min(0, ...values) : Math.min(...values);
  let maximum = includeZero ? Math.max(0, ...values) : Math.max(...values);
  if (minimum === maximum) {
    minimum -= 1;
    maximum += 1;
  }
  const span = maximum - minimum;
  if (![minimum, maximum, span].every(Number.isFinite) || span <= 0) {
    integrationInvalid(`${label} produces an unsupported numeric range`);
  }
}

function validateLabel(value, label, maximum = 120) {
  const text = integrationBoundedText(redactPublicText(value), label, maximum, { minimum: 1, presentational: true }).trim();
  if (!text) integrationInvalid(`${label} must contain a non-whitespace character`);
  return text;
}

function denseDataArray(value, label, { minimum = 0, maximum } = {}) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    integrationInvalid(`${label} must contain ${minimum}-${maximum} entries`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= value.length ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      integrationInvalid(`${label} must contain only dense enumerable data entries`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
      integrationInvalid(`${label} may not contain sparse entries`);
    }
  }
  return value;
}

export function validateIntegrationPlotSpec(value) {
  const spec = integrationExactKeys(
    value,
    ["schemaVersion", "type", "xLabel", "yLabel", "labels", "series"],
    "plot spec",
    ["schemaVersion", "type", "series"]
  );
  if (spec.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("plot spec schemaVersion must be 1");
  if (!PLOT_TYPES.has(spec.type)) integrationInvalid("plot type is unsupported");
  if (!Array.isArray(spec.series) || spec.series.length < 1 || spec.series.length > 8) {
    integrationInvalid("plot series must contain 1-8 entries");
  }

  const categorical = spec.type !== "scatter";
  let labels;
  if (categorical) {
    if (!Array.isArray(spec.labels) || spec.labels.length < 1 || spec.labels.length > 128) {
      integrationInvalid("line, bar, and area plots require 1-128 labels");
    }
    labels = spec.labels.map((item, index) => validateLabel(item, `plot labels[${index}]`, 160));
  } else {
    if (spec.labels !== undefined) integrationInvalid("scatter plots do not accept labels");
    labels = undefined;
  }

  let totalPoints = 0;
  const names = new Set();
  const series = spec.series.map((item, index) => {
    const entry = integrationExactKeys(
      item,
      categorical ? ["name", "data"] : ["name", "points"],
      `plot series[${index}]`,
      categorical ? ["name", "data"] : ["name", "points"]
    );
    const name = validateLabel(entry.name, `plot series[${index}].name`);
    if (names.has(name)) integrationInvalid("plot series names must be unique");
    names.add(name);
    if (categorical) {
      if (!Array.isArray(entry.data) || entry.data.length !== labels.length) {
        integrationInvalid(`plot series[${index}].data must match labels length`);
      }
      totalPoints += entry.data.length;
      return Object.freeze({
        name,
        data: Object.freeze(entry.data.map((point, pointIndex) => plotNumber(point, `plot series[${index}].data[${pointIndex}]`))),
      });
    }
    if (!Array.isArray(entry.points) || entry.points.length < 1) integrationInvalid(`plot series[${index}].points must not be empty`);
    totalPoints += entry.points.length;
    return Object.freeze({
      name,
      points: Object.freeze(
        entry.points.map((point, pointIndex) => {
          const normalized = integrationExactKeys(point, ["x", "y"], `plot series[${index}].points[${pointIndex}]`, ["x", "y"]);
          return Object.freeze({
            x: plotNumber(normalized.x, `plot series[${index}].points[${pointIndex}].x`),
            y: plotNumber(normalized.y, `plot series[${index}].points[${pointIndex}].y`),
          });
        })
      ),
    });
  });
  if (totalPoints > 500) integrationInvalid("plot contains more than 500 total points");
  const normalizedPoints = series.flatMap((entry) => categorical
    ? entry.data.map((y, x) => ({ x, y }))
    : entry.points);
  validatePlotRange(normalizedPoints.map(({ y }) => y), "plot y values", { includeZero: true });
  validatePlotRange(normalizedPoints.map(({ x }) => x), "plot x values");

  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    type: spec.type,
    ...(spec.xLabel === undefined ? {} : { xLabel: validateLabel(spec.xLabel, "plot xLabel") }),
    ...(spec.yLabel === undefined ? {} : { yLabel: validateLabel(spec.yLabel, "plot yLabel") }),
    ...(labels === undefined ? {} : { labels: Object.freeze(labels) }),
    series: Object.freeze(series),
  });
}

function validateTableCell(value, label) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, label);
  return integrationBoundedText(redactPublicText(value), label, 2_000, { presentational: true });
}

export function validateIntegrationTableSpec(value) {
  const spec = integrationExactKeys(value, ["schemaVersion", "columns", "rows"], "table spec", [
    "schemaVersion",
    "columns",
    "rows",
  ]);
  if (spec.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("table spec schemaVersion must be 1");
  if (!Array.isArray(spec.columns) || spec.columns.length < 1 || spec.columns.length > 12) integrationInvalid("table columns must contain 1-12 entries");
  if (!Array.isArray(spec.rows) || spec.rows.length > 200) integrationInvalid("table rows may contain at most 200 entries");
  const keys = new Set();
  const columns = spec.columns.map((column, index) => {
    const entry = integrationExactKeys(column, ["key", "label"], `table columns[${index}]`, ["key", "label"]);
    if (typeof entry.key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(entry.key) || keys.has(entry.key)) {
      integrationInvalid(`table columns[${index}].key is invalid or duplicated`);
    }
    keys.add(entry.key);
    return Object.freeze({ key: entry.key, label: validateLabel(entry.label, `table columns[${index}].label`) });
  });
  const rows = spec.rows.map((row, rowIndex) => {
    const object = integrationExactKeys(row, [...keys], `table rows[${rowIndex}]`);
    return Object.freeze(Object.fromEntries(columns.map(({ key }) => [key, validateTableCell(object[key] ?? null, `table rows[${rowIndex}].${key}`)])));
  });
  return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, columns: Object.freeze(columns), rows: Object.freeze(rows) });
}

export function validateIntegrationMarkdownSpec(value) {
  const spec = integrationExactKeys(value, ["schemaVersion", "markdown"], "markdown spec", ["schemaVersion", "markdown"]);
  if (spec.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("markdown spec schemaVersion must be 1");
  const markdown = integrationBoundedText(redactPublicText(spec.markdown), "markdown", 32_000);
  if (/<\/?[A-Za-z][^>]*>|!\[[^\]]*\]\s*\(|\[[^\]]+\]\s*\([^)]*\)|(?:https?|data|file|javascript)\s*:|(?:^|[\s("'`])\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/|\b)|(?:^|[\s("'`])[A-Za-z]:\\/imu.test(markdown)) {
    integrationInvalid("markdown artifacts may not contain HTML, links, images, URL schemes, or private runtime paths", {
      code: "UNSAFE_PRESENTATION",
    });
  }
  return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, markdown });
}

export function validateIntegrationFileSpec(value) {
  const spec = integrationExactKeys(
    value,
    ["schemaVersion", "filename", "mime", "bytes", "sha256"],
    "file spec",
    ["schemaVersion", "filename", "mime", "bytes", "sha256"]
  );
  if (spec.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) {
    integrationInvalid("file spec schemaVersion must be 1");
  }
  const filename = integrationBoundedText(spec.filename, "file filename", 240, {
    minimum: 1,
    presentational: true,
  });
  if (
    !filename ||
    filename.trim() !== filename ||
    filename === "." ||
    filename === ".." ||
    !filename.slice(0, -4) ||
    filename.slice(0, -4) === "." ||
    filename.slice(0, -4) === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(filename)
  ) {
    integrationInvalid("file filename must be one safe basename");
  }
  const mime = integrationBoundedText(spec.mime, "file mime", 100, { minimum: 1 });
  if (mime !== mime.toLowerCase()) integrationInvalid("file mime must be lowercase");
  if (!new Set(["application/pdf", "application/x-tex", "text/x-tex"]).has(mime)) {
    integrationInvalid("file mime is unsupported");
  }
  if ((mime === "application/pdf") !== /\.pdf$/iu.test(filename)) {
    integrationInvalid("file filename extension does not match mime");
  }
  if (mime !== "application/pdf" && !/\.tex$/iu.test(filename)) {
    integrationInvalid("file filename extension does not match mime");
  }
  if (!Number.isSafeInteger(spec.bytes) || spec.bytes < 1 || spec.bytes > MAX_INTEGRATION_FILE_ARTIFACT_BYTES) {
    integrationInvalid("file bytes is outside its supported bound");
  }
  if (typeof spec.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(spec.sha256)) {
    integrationInvalid("file sha256 is invalid");
  }
  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    filename,
    mime,
    bytes: spec.bytes,
    sha256: spec.sha256,
  });
}

function validateSourceUrl(value, label) {
  const raw = integrationBoundedText(value, label, 2_048, { minimum: 1 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    integrationInvalid(`${label} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hash
  ) {
    integrationInvalid(`${label} must be a credential-free HTTPS URL without a fragment`);
  }
  for (const [key] of parsed.searchParams) {
    if (CREDENTIAL_QUERY_NAME.test(key)) {
      integrationInvalid(`${label} may not contain credential query fields`);
    }
  }
  return parsed.href;
}

function validateSourceDate(value, label) {
  if (value === null) return null;
  const text = integrationBoundedText(value, label, 10, { minimum: 10 });
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(text) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    integrationInvalid(`${label} must be a canonical calendar date or null`);
  }
  return text;
}

function validateSourceDoi(value, label) {
  if (value === null) return null;
  const text = integrationBoundedText(value, label, 300, { minimum: 7, presentational: true }).trim();
  if (!/^10\.\d{4,9}\/[A-Za-z0-9][A-Za-z0-9._;()/:+-]*$/u.test(text)) {
    integrationInvalid(`${label} must be a DOI or null`);
  }
  return text;
}

export function validateIntegrationSourcesSpec(value) {
  const spec = integrationExactKeys(value, ["schemaVersion", "sources"], "sources spec", [
    "schemaVersion",
    "sources",
  ]);
  if (spec.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) {
    integrationInvalid("sources spec schemaVersion must be 1");
  }
  const sourceItems = denseDataArray(spec.sources, "sources", {
    minimum: 1,
    maximum: INTEGRATION_MAXIMUM_SEARCH_SOURCES,
  });
  const sources = sourceItems.map((source, offset) => {
    const item = integrationExactKeys(
      source,
      ["index", "title", "url", "snippet", "providers", "kind", "publishedDate", "doi"],
      `sources[${offset}]`,
      ["index", "title", "url", "snippet", "providers", "kind", "publishedDate", "doi"]
    );
    if (item.index !== offset + 1) {
      integrationInvalid(`sources[${offset}].index must match its one-based position`);
    }
    const providerItems = denseDataArray(item.providers, `sources[${offset}].providers`, {
      minimum: 1,
      maximum: 12,
    });
    const providers = providerItems.map((provider, index) =>
      validateLabel(provider, `sources[${offset}].providers[${index}]`, 100)
    );
    if (new Set(providers).size !== providers.length) {
      integrationInvalid(`sources[${offset}].providers must be unique`);
    }
    if (item.kind !== "web" && item.kind !== "paper") {
      integrationInvalid(`sources[${offset}].kind must be web or paper`);
    }
    return Object.freeze({
      index: item.index,
      title: validateLabel(item.title, `sources[${offset}].title`, 500),
      url: validateSourceUrl(item.url, `sources[${offset}].url`),
      snippet: integrationBoundedText(
        redactPublicText(item.snippet),
        `sources[${offset}].snippet`,
        4_000,
        { presentational: true }
      ).trim(),
      providers: Object.freeze(providers),
      kind: item.kind,
      publishedDate: validateSourceDate(item.publishedDate, `sources[${offset}].publishedDate`),
      doi: validateSourceDoi(item.doi, `sources[${offset}].doi`),
    });
  });
  return Object.freeze({ schemaVersion: AGENT_WORKER_SCHEMA_VERSION, sources: Object.freeze(sources) });
}

function normalizeArtifactKind(input = {}) {
  const kind = String(input.kind || input.type || "").trim();
  if (INTEGRATION_ARTIFACT_KINDS.includes(kind) || kind === INTEGRATION_SEARCH_ARTIFACT_KIND) return kind;
  if (kind === "plot.v1") return "plot";
  if (kind === "table.v1") return "table";
  if (kind === "markdown.v1" || kind === "md") return "markdown";
  return "";
}

function normalizeArtifactSpec(kind, input = {}) {
  if (input.spec) return input.spec;
  if (kind === "markdown") {
    return {
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      markdown: input.markdown ?? input.content ?? "",
    };
  }
  if (kind === "file") return input.spec || {};
  if (kind === "table") {
    return {
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      columns: input.columns || input.table?.columns || [],
      rows: input.rows || input.table?.rows || [],
    };
  }
  if (kind === "plot") {
    return {
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      ...(input.plot || input),
    };
  }
  if (kind === INTEGRATION_SEARCH_ARTIFACT_KIND) {
    return {
      schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
      sources: input.sources || [],
    };
  }
  return {};
}

export function sanitizeIntegrationArtifact(input = {}) {
  const artifact = integrationExactKeys(
    input,
    ["id", "title", "kind", "type", "spec", "markdown", "content", "columns", "rows", "table", "plot", "sources"],
    "artifact"
  );
  const kind = normalizeArtifactKind(artifact);
  if (!kind) integrationInvalid("artifact kind is unsupported");
  const title = validateLabel(
    artifact.title || (kind === "markdown" ? "Markdown" : kind === INTEGRATION_SEARCH_ARTIFACT_KIND ? "Grounded sources" : "Artifact"),
    "artifact title"
  );
  const spec =
    kind === "plot"
      ? validateIntegrationPlotSpec(normalizeArtifactSpec(kind, artifact))
      : kind === "table"
        ? validateIntegrationTableSpec(normalizeArtifactSpec(kind, artifact))
        : kind === "markdown"
          ? validateIntegrationMarkdownSpec(normalizeArtifactSpec(kind, artifact))
          : kind === "file"
            ? validateIntegrationFileSpec(normalizeArtifactSpec(kind, artifact))
            : validateIntegrationSourcesSpec(normalizeArtifactSpec(kind, artifact));
  const id = validateIntegrationArtifactId(artifact.id || stableArtifactId({ kind, title, spec }));
  const normalized = { id, title, kind, spec };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_INTEGRATION_PUBLIC_ARTIFACT_BYTES) {
    integrationInvalid("artifact exceeds its 48 KiB public contract", { code: "ARTIFACT_TOO_LARGE" });
  }
  return Object.freeze(normalized);
}

export function buildIntegrationArtifacts(options = {}) {
  const candidates = [];
  for (const artifact of options.artifacts || []) candidates.push(artifact);

  const byId = new Map();
  for (const candidate of candidates) {
    try {
      const sanitized = sanitizeIntegrationArtifact(candidate);
      byId.set(sanitized.id, sanitized);
    } catch {
      // Unsafe or non-public artifacts are intentionally omitted.
    }
  }

  return Object.freeze({
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    artifacts: Object.freeze([...byId.values()].slice(-32)),
  });
}

export function findIntegrationArtifact(artifacts = [], artifactId = "") {
  const id = validateIntegrationArtifactId(artifactId);
  const found = artifacts.find((artifact) => artifact.id === id);
  if (!found) {
    throw new IntegrationValidationError("NOT_FOUND", "Artifact not found.", { status: 404, details: { artifactId: id } });
  }
  return sanitizeIntegrationArtifact(found);
}
