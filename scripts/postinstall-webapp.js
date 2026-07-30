#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldStartPostinstallWebApp } from "../src/postinstall-policy.js";
import { ensureAgintiWebApp } from "../src/web-autostart.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.env.INIT_CWD || process.cwd();

if (!shouldStartPostinstallWebApp(process.env)) {
  process.exit(0);
}

try {
  await ensureAgintiWebApp({
    packageDir,
    cwd,
    host: process.env.AGINTI_WEB_HOST || "127.0.0.1",
    preferredPort: process.env.AGINTI_WEB_PORT || 3210,
    language: process.env.AGINTI_LANGUAGE || "",
  });
} catch {
  // Installation must not fail because the optional local webapp could not be started.
}
