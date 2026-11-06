import assert from "node:assert/strict";
import path from "node:path";
import * as childProcess from "node:child_process";
import { mock } from "node:test";
mock.module("node:child_process", { namedExports: { ...childProcess,
  spawn(command, args, options) { assert.notEqual(command, "codex", "fresh process redispatched a completed advisory call"); return childProcess.spawn(command, args, options); },
  execFileSync(command, args, options) {
    if (command === "sh" && args?.[1] === "command -v codex") return Buffer.from("/synthetic/codex\n");
    return childProcess.execFileSync(command, args, options);
  },
} });
globalThis.fetch = async () => { throw Error("Offline replay must not access the network"); };
const { runAgent } = await import("../../src/agent-runner.js");
const { resolveRuntimeConfig } = await import("../../src/config.js");
const { closeSessionIndexConnections } = await import("../../src/session-index.js");
const root = process.argv[2]; let calls = 0, reused = 0;
const clientFactory = async () => ({ chat: { completions: { create: async request => {
  if (!request.tools) return { choices: [{ message: { role: "assistant", content: "Use the exact retained advice and report the result." } }] };
  const name = ++calls === 1 ? "delegate_agent" : "finish";
  const args = name === "delegate_agent" ? { wrapper: "codex", prompt: "Read-only: check the supplied expression 2 * 3. Do not run tools." }
    : { result: "The retained independent advice states that the expression evaluates to 6." };
  return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "restart_" + calls, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
} } } });
clientFactory.agintiDeterministicTest = true;
const config = resolveRuntimeConfig({ provider: "openai", model: "scripted-advisory", routingMode: "manual", enableScs: "off", goal: "Continue the same task." }, {
  baseDir: root, commandCwd: root, packageDir: path.resolve(import.meta.dirname, "../.."), sessionId: "advisory-runtime", clientFactory,
  sandboxMode: "host", allowWrapperTools: true, preferredWrapper: "codex", wrapperModel: "cli-default", wrapperReasoning: "medium",
  allowFileTools: true, allowShellTool: true, allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false,
});
Object.assign(config, { clientFactory, apiKey: "synthetic-only", resume: "advisory-runtime", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  scsActive: false, allowProviderHandoff: false, maxSteps: 4, dynamicSteps: "off", onConsole: () => {}, onLog: () => {},
  onEvent(type, data) { if (type === "tool.reused" && data.toolName === "delegate_agent") reused++; },
});
try {
  const result = await runAgent(config); assert.notEqual(result.stopped, true, JSON.stringify(result)); assert.equal(calls, 2);
  const fs = await import("node:fs/promises"); const state = JSON.parse(await fs.readFile(path.join(root, "sessions/advisory-runtime/state.json"), "utf8"));
  console.log(JSON.stringify({ ok: true, reused, newCliLaunches: 0, resultDigest: state.meta.advisoryInvocation.attempt.resultDigest }));
} finally { closeSessionIndexConnections(); }
