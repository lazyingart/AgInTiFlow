import { appendFileSync } from "node:fs";
const options = new URL(import.meta.url).searchParams;
const trace = options.get("trace");
const ownSource = options.get("source");
const client = options.get("client") === "1";
const deniedFiles = new Set(["integration-analysis-vision.js", "model-http-client.js", "provider-runtime.js", "agent-runner.js", "session-store.js", "config.js"]);
const io = new Set(["node:fs", "node:fs/promises", "node:child_process", "node:http", "node:https", "node:net", "node:tls"]);
export async function resolve(specifier, context, next) {
  const fromCore = Boolean(context.parentURL?.startsWith(ownSource));
  const bare = !specifier.startsWith("node:") && !specifier.startsWith("file:") && !specifier.startsWith(".") && !specifier.startsWith("/");
  const file = specifier.split("/").at(-1);
  const selectedHttp = client && context.parentURL?.endsWith("/restricted-deepseek-http.js") && specifier === "node:https";
  const denied = bare || (fromCore && (deniedFiles.has(file) || (io.has(specifier) && !selectedHttp)));
  if (trace) appendFileSync(trace, JSON.stringify({ specifier, fromCore, denied }) + "\n");
  if (denied) throw Object.assign(new Error("Unselected provider/runner/IO is outside restricted startup."), { code: "SDK_STARTUP_ISOLATION" });
  return next(specifier, context);
}
