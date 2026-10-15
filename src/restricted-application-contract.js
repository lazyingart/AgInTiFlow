import { types } from "node:util";
import { hasSensitiveText } from "./redaction.js";

export class RestrictedApplicationError extends Error {
  constructor(code) {
    super(`Restricted application run rejected: ${code}`);
    this.name = "RestrictedApplicationError";
    this.code = code;
  }
}

export function fail(code = "INVALID_CONTRACT") {
  throw new RestrictedApplicationError(code);
}

// Do not invoke JSON hooks, getters, custom iterators or proxy traps at a boundary.
export function dataFields(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor.enumerable || !("value" in descriptor)) fail();
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) fail();
  return result;
}

export function jsonSnapshot(value, { maxBytes = 256 * 1024, maxNodes = 20_000 } = {}) {
  let nodes = 0;
  let bytes = 0;
  const active = new Set();
  function clone(item, depth) {
    if (++nodes > maxNodes || depth > 32) fail("DATA_LIMIT");
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      bytes += 24;
      if (bytes > maxBytes) fail("DATA_LIMIT");
      return item;
    }
    if (typeof item === "string") {
      if (!item.isWellFormed()) fail("INVALID_DATA");
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > maxBytes) fail("DATA_LIMIT");
      return item;
    }
    if (!item || typeof item !== "object" || types.isProxy(item) || active.has(item)) fail("INVALID_DATA");
    active.add(item);
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) fail("INVALID_DATA");
    const keys = Reflect.ownKeys(item);
    const output = array ? [] : Object.create(null);
    if (keys.length > maxNodes || (array && keys.length !== item.length + 1)) fail("INVALID_DATA");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype", "toJSON", "then"].includes(key)) fail("INVALID_DATA");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail("INVALID_DATA");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !("value" in descriptor)) fail("INVALID_DATA");
      bytes += Buffer.byteLength(key) + 4;
      output[key] = clone(descriptor.value, depth + 1);
    }
    active.delete(item);
    if (bytes > maxBytes) fail("DATA_LIMIT");
    return Object.freeze(output);
  }
  const result = clone(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail("DATA_LIMIT");
  return result;
}

export function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}

export function text(value, max, allowEmpty = false) {
  if (typeof value !== "string" || !value.isWellFormed() || (!allowEmpty && !value.trim()) || Buffer.byteLength(value) > max) fail("INVALID_DATA");
  return value;
}

export function assertNoCredentials(value) {
  if (typeof value === "string") {
    if (hasSensitiveText(value) || /-----BEGIN .*PRIVATE KEY-----|\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/.test(value)) fail("SENSITIVE_DATA");
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:api[_-]?key|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token)$/i.test(key)) fail("SENSITIVE_DATA");
      assertNoCredentials(child);
    }
  }
}

// Deliberately small, closed JSON Schema dialect. Unsupported keywords fail
// configuration rather than silently weakening the host's validation contract.
export function checkedSchema(value) {
  const schema = jsonSnapshot(value, { maxBytes: 32 * 1024, maxNodes: 2000 });
  function check(node, depth = 0) {
    if (depth > 12 || !node || Array.isArray(node) || typeof node !== "object") fail();
    if (Object.hasOwn(node, "anyOf")) {
      dataFields(node, ["anyOf"]);
      if (!Array.isArray(node.anyOf)) fail();
      integer(node.anyOf.length, 2, 8);
      node.anyOf.forEach((child) => check(child, depth + 1));
      return;
    }
    const keywords = {
      object: ["properties", "required", "additionalProperties"],
      array: ["items", "minItems", "maxItems"],
      string: ["minLength", "maxLength"],
      integer: ["minimum", "maximum"],
      number: ["minimum", "maximum"],
      boolean: [], null: [],
    };
    if (typeof node.type !== "string" || !Object.hasOwn(keywords, node.type)) fail();
    dataFields(node, ["type", "description", "enum", ...keywords[node.type]], ["type"]);
    if (node.description !== undefined) text(node.description, 2000);
    if (node.type === "object") {
      if (node.additionalProperties !== false || !node.properties || typeof node.properties !== "object" || Array.isArray(node.properties) || !Array.isArray(node.required)) fail();
      const names = Object.keys(node.properties);
      integer(names.length, 0, 64);
      if (new Set(node.required).size !== node.required.length || node.required.some((name) => typeof name !== "string" || !names.includes(name))) fail();
      for (const name of names) { text(name, 128); check(node.properties[name], depth + 1); }
    } else if (node.type === "array") {
      integer(node.maxItems, 0, 1000);
      if (node.minItems !== undefined) integer(node.minItems, 0, node.maxItems);
      check(node.items, depth + 1);
    } else if (node.type === "string") {
      integer(node.maxLength, 0, 100_000);
      if (node.minLength !== undefined) integer(node.minLength, 0, node.maxLength);
    } else if (["integer", "number"].includes(node.type)) {
      for (const key of ["minimum", "maximum"]) {
        if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) fail();
      }
      if (node.minimum > node.maximum) fail();
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum)) fail();
      integer(node.enum.length, 1, 64);
      if (node.enum.some((entry) => !matchesSchema(entry, { ...node, enum: undefined }))) fail();
    }
  }
  check(schema);
  assertNoCredentials(schema);
  return schema;
}

export function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((part) => matchesSchema(value, part));
  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": case "integer":
      return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    case "string": {
      if (typeof value !== "string") return false;
      const length = Array.from(value).length;
      return length >= (schema.minLength ?? 0) && length <= schema.maxLength;
    }
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= schema.maxItems && value.every((item) => matchesSchema(item, schema.items));
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value) &&
      schema.required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => Object.hasOwn(schema.properties, key) && matchesSchema(value[key], schema.properties[key]));
    default: return false;
  }
}
