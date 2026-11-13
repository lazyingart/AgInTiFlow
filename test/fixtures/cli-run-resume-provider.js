import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = process.env.AGINTI_TEST_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const trace = process.env.AGINTI_TEST_RESUME_TRACE;
if (!trace) throw Error("Offline resume fixture requires an explicit trace");
let requests = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["https://api.deepseek.com", "https://api.openai.com"].includes(url.origin) || !url.pathname.endsWith("/chat/completions")) throw Error("OFFLINE_NETWORK_ESCAPE_REFUSED");
  if (++requests > 12) throw Error("OFFLINE_REQUEST_CAP");
  const authorization = new Headers(options.headers).get("authorization");
  const expectedKey = url.origin === "https://api.openai.com" ? "synthetic-offline-openai-key" : "synthetic-offline-provider-key";
  if (authorization !== "Bearer " + expectedKey) throw Error("OFFLINE_CROSS_PROVIDER_CREDENTIAL_REFUSED");
  const body = JSON.parse(options.body);
  await fs.appendFile(trace, JSON.stringify({ origin: url.origin, model: body.model, providerCredentialMatched: true, tools: body.tools?.map(t => t.function.name) || [] }) + "\n");
  if (process.env.AGINTI_TEST_RESUME_MODE === "provider-reject") return new Response(JSON.stringify({ error: { message: "Synthetic offline provider rejection", code: "invalid_model" } }), { status: 400, headers: { "content-type": "application/json" } });
  const message = body.tools ? { role: "assistant", content: null, reasoning_content: "Answer the supplied conversation without effects.", tool_calls: [{ id: "resume_contract_" + requests, type: "function", function: { name: "finish", arguments: JSON.stringify({ result: "The saved note says the release window is Wednesday." }) } }] }
    : { role: "assistant", content: "1. Read the supplied conversation.\n2. Answer briefly without effects." };
  return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: body.tools ? "tool_calls" : "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
};

if (process.env.AGINTI_TEST_RESUME_MODE === "stale-cas") {
  const { SessionStore } = await import(pathToFileURL(path.join(runtime, "src/session-store.js")));
  const descriptor = Object.getOwnPropertyDescriptor(SessionStore.prototype, "loadState");
  let used = false;
  Object.defineProperty(SessionStore.prototype, "loadState", { ...descriptor, value: async function (...args) {
    const state = await Reflect.apply(descriptor.value, this, args);
    if (!used && state) {
      used = true;
      const changed = structuredClone(state); changed.meta.runtimeConfig.revision++;
      await fs.writeFile(this.statePath, JSON.stringify(changed, null, 2) + "\n");
      await fs.writeFile(trace + ".cas", "concurrent runtime revision advanced\n");
    }
    return state;
  } });
}
