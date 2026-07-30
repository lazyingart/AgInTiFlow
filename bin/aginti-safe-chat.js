#!/usr/bin/env node
import { listenSafeChatServer } from "../src/safe-chat-server.js";
import { redactSensitiveText } from "../src/redaction.js";

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: aginti-safe-chat [--host 127.0.0.1] [--port 3212]");
  console.log("Starts the authenticated loopback-only, server-owned DeepSeek text fallback.");
  process.exit(0);
}

const running = await listenSafeChatServer({
  host: optionValue(argv, "--host") || undefined,
  port: optionValue(argv, "--port") || undefined,
}).catch((error) => {
  console.error(`aginti-safe-chat unavailable: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
  return null;
});

if (running) {
  console.log(`aginti-safe-chat: ${running.url}`);
  const stop = () => {
    running.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1500).unref?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
