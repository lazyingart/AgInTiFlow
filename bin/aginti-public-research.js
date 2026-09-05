#!/usr/bin/env node
import { listenPublicResearchServer } from "../src/public-research-server.js";

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: aginti-public-research [--host 127.0.0.1] [--port 3211]");
  console.log("Use --port 0 to let the operating system allocate an ephemeral loopback port.");
  console.log("Starts only the fail-closed public research API; it does not start AgInTiFlow Studio or chat.");
  process.exit(0);
}

const running = await listenPublicResearchServer({
  host: optionValue(argv, "--host") || undefined,
  port: optionValue(argv, "--port") || undefined,
}).catch((error) => {
  console.error(`aginti-public-research unavailable: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  return null;
});

if (running) {
  console.log(`aginti-public-research: ${running.url}`);
  const stop = () => {
    running.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1500).unref?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
