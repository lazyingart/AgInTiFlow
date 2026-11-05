import assert from "node:assert/strict";
import test from "node:test";
import { assessCodexToolCatalog, probeRestrictedCodex } from "../scripts/probe-restricted-codex.js";

test("an advertised passive or host tool always prevents no-tools observation", () => {
  for (const name of ["request_user_input", "exec_command", "apply_patch", "web_search"]) {
    const result = assessCodexToolCatalog({ tools: [{ type: "function", name }], tool_choice: "none" });
    assert.equal(result.noToolsObserved, false);
    assert.equal(result.enabled, false);
    assert.equal(result.productionQualified, false);
    assert.equal(result.reason, "TOOLS_STILL_ADVERTISED");
    assert.deepEqual([...result.advertisedTools], [name]);
  }
});

test("even an empty observed catalog cannot self-attest production admission", () => {
  const result = assessCodexToolCatalog({ tools: [] });
  assert.equal(result.noToolsObserved, true);
  assert.equal(result.enabled, false);
  assert.equal(result.productionQualified, false);
  assert.equal(result.reason, "ISOLATION_AUTH_AND_LIFECYCLE_NOT_QUALIFIED");
  assert(Object.isFrozen(result) && Object.isFrozen(result.advertisedTools));
});

test("absent or malformed catalogs cannot count as no-tools", () => {
  for (const value of [{}, { tools: null }, { tools: false }, { tools: {} }, { tools: [null] }, { tools: [{ type: "function", name: "" }] }, { tools: Array(1) }, { tools: Array.from({ length: 129 }, () => ({ type: "function", name: "x" })) }]) {
    assert.throws(() => assessCodexToolCatalog(value));
  }
});

test("descriptor/proxy boundaries run before any attacker hook", async () => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error("trap"); }, ownKeys() { traps++; throw Error("trap"); } });
  const getter = { get tools() { traps++; throw Error("getter"); } };
  const hidden = {}; Object.defineProperty(hidden, "tools", { value: [] });
  for (const value of [proxy, getter, hidden, { tools: [proxy] }, { tools: [], [Symbol()]: true }]) assert.throws(() => assessCodexToolCatalog(value));
  await assert.rejects(probeRestrictedCodex(proxy));
  await assert.rejects(probeRestrictedCodex({ get executable() { traps++; throw Error("getter"); } }));
  assert.equal(traps, 0);
});

test("diagnostic requires an explicit trusted absolute executable", async () => {
  await assert.rejects(probeRestrictedCodex({ executable: "codex" }));
  await assert.rejects(probeRestrictedCodex({ executable: "/unused", provider: "openai" }));
});
