#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUXILIARY_MODEL_CATALOG,
  MODEL_PROVIDER_GROUPS,
  getModelRoleDefaults,
  modelsForProviderGroup,
  selectModelRoute,
} from "../src/model-routing.js";
import { parseTextToolCalls } from "../src/model-client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("model role CLI smoke timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model role CLI smoke failed ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function runInteractive(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "chat"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "test-deepseek-key-not-real",
        VENICE_API_KEY: process.env.VENICE_API_KEY || "test-venice-key-not-real",
        AGINTIFLOW_NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("model role interactive smoke timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model role interactive smoke failed ${code}\n${stdout}\n${stderr}`));
    });
    child.stdin.end(input);
  });
}

const roles = getModelRoleDefaults();
assert(roles.route.provider === "deepseek", "route provider default should be deepseek");
assert(roles.route.model === "deepseek-v4-flash", "route model default should be deepseek-v4-flash");
assert(roles.main.model === "deepseek-v4-pro", "main model default should be deepseek-v4-pro");
assert(roles.spare.provider === "openai" && roles.spare.model === "gpt-5.4", "spare model default should be OpenAI GPT-5.4");
assert(roles.wrapper.provider === "codex" && roles.wrapper.model === "gpt-5.5", "wrapper default should be Codex GPT-5.5");
assert(roles.auxiliary.provider === "grsai" && roles.auxiliary.model === "nano-banana-2", "auxiliary default should be GRS AI Nano Banana");

const complexRoute = selectModelRoute({
  routingMode: "complex",
  provider: "deepseek",
  mainModel: "deepseek-v4-pro",
});
assert(complexRoute.model === "deepseek-v4-pro", "complex route did not use main model override");

const fastRoute = selectModelRoute({
  routingMode: "fast",
  provider: "deepseek",
  routeModel: "deepseek-v4-flash",
});
assert(fastRoute.model === "deepseek-v4-flash", "fast route did not use route model override");

assert(MODEL_PROVIDER_GROUPS["venice-gpt"].provider === "venice", "venice-gpt group missing");
assert(modelsForProviderGroup("venice-gemma").some((item) => item.id === "gemma-4-uncensored"), "venice-gemma bucket missing Gemma");
assert(modelsForProviderGroup("venice-uncensored").some((item) => item.id === "e2ee-venice-uncensored-24b-p"), "venice-uncensored bucket missing Venice 1.1");
assert(AUXILIARY_MODEL_CATALOG["venice-image"].some((item) => item.id === "gpt-image-2"), "Venice image catalog missing GPT Image 2");
const parsedTextToolCalls = parseTextToolCalls('[TOOL_CALLS]list_files[ARGS]call_123[ARGS]{"path":".","maxDepth":1}');
assert(parsedTextToolCalls.length === 1, "Venice text tool-call parser did not detect encoded tool call");
assert(parsedTextToolCalls[0].function.name === "list_files", "Venice text tool-call parser returned wrong tool name");
assert(parsedTextToolCalls[0].function.arguments.includes('"maxDepth":1'), "Venice text tool-call parser returned wrong arguments");

const output = await runCli(["models"]);
assert(output.includes("/route") && output.includes("/spare") && output.includes("venice-gpt"), "aginti models output missing role details");

const interactiveOutput = await runInteractive("/venice\n");
assert(interactiveOutput.includes("venice=on"), "/venice did not enable Venice roles");
assert(interactiveOutput.includes("route=venice/venice-uncensored-1-2"), "/venice did not set Venice route role");
assert(interactiveOutput.includes("main=venice/venice-uncensored-1-2"), "/venice did not set Venice main role");
const interactiveGemmaOutput = await runInteractive("/venice 1.1 gemma\n");
assert(interactiveGemmaOutput.includes("route=venice/e2ee-venice-uncensored-24b-p"), "/venice 1.1 did not set Venice 1.1 route role");
assert(interactiveGemmaOutput.includes("main=venice/gemma-4-uncensored"), "/venice gemma did not set Gemma 4 main role");
const interactiveOffOutput = await runInteractive("/venice off\n");
assert(interactiveOffOutput.includes("venice=off"), "/venice off did not restore DeepSeek roles");
assert(interactiveOffOutput.includes("route=deepseek/deepseek-v4-flash"), "/venice off did not restore DeepSeek route role");

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "role-defaults",
        "route-overrides",
        "provider-groups",
        "auxiliary-catalog",
        "venice-text-tool-parser",
        "cli-models-command",
        "venice-shortcut",
      ],
    },
    null,
    2
  )
);
