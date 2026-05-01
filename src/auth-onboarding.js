import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import { providerKeyStatus, setProviderKey } from "./project.js";

class MutedWritable extends Writable {
  constructor(target) {
    super();
    this.target = target;
    this.muted = false;
  }

  _write(chunk, encoding, callback) {
    if (!this.muted) this.target.write(chunk, encoding);
    callback();
  }
}

export async function promptHidden(promptText) {
  if (!input.isTTY || !output.isTTY) return "";

  const mutedOutput = new MutedWritable(output);
  const rl = readline.createInterface({
    input,
    output: mutedOutput,
    terminal: true,
  });

  try {
    output.write(promptText);
    mutedOutput.muted = true;
    const value = await rl.question("");
    output.write("\n");
    return String(value || "").trim();
  } finally {
    mutedOutput.muted = false;
    rl.close();
  }
}

export function shouldPromptForDeepSeek(args = {}, projectRoot = process.cwd()) {
  const provider = String(args.provider || "").toLowerCase();
  if (provider === "mock" || provider === "openai") return false;
  if (process.env.AGINTIFLOW_NO_AUTH_PROMPT === "1") return false;
  if (!input.isTTY || !output.isTTY) return false;
  return !providerKeyStatus(projectRoot).deepseek;
}

export async function promptAndSaveDeepSeekKey(projectRoot = process.cwd(), options = {}) {
  const key = await promptHidden(
    options.promptText || "DeepSeek API key not found. Paste DEEPSEEK_API_KEY to save locally, or press Enter to skip: "
  );
  if (!key) return { saved: false, skipped: true };

  const result = await setProviderKey(projectRoot, "deepseek", key);
  return {
    saved: true,
    provider: result.provider,
    keyName: result.keyName,
    path: result.path,
  };
}
