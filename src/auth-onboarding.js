import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import { providerKeyStatus, setProviderKey } from "./project.js";

export const MAIN_AUTH_PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    keyName: "DEEPSEEK_API_KEY",
    description: "default fast/pro route",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyName: "OPENAI_API_KEY",
    description: "OpenAI-compatible fallback",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "qwen",
    label: "Qwen",
    keyName: "QWEN_API_KEY",
    description: "Qwen OpenAI-compatible route",
  },
];

const AUXILIARY_AUTH_PROVIDER = {
  id: "grsai",
  label: "GRS AI / Nano Banana",
  keyName: "GRSAI",
  description: "optional image generation",
};

const AUTH_ALIASES = {
  auxiliary: "grsai",
  auxilliary: "grsai",
  image: "grsai",
  imagegen: "grsai",
  grs: "grsai",
  grsai: "grsai",
  deepseek: "deepseek",
  ds: "deepseek",
  openai: "openai",
  qwen: "qwen",
};

export function normalizeAuthProvider(provider = "", fallback = "deepseek") {
  const normalized = AUTH_ALIASES[String(provider || "").trim().toLowerCase()] || String(provider || "").trim().toLowerCase();
  return ["deepseek", "openai", "qwen", "grsai"].includes(normalized) ? normalized : fallback;
}

function providerLabel(provider = "") {
  const match = [...MAIN_AUTH_PROVIDERS, AUXILIARY_AUTH_PROVIDER].find((item) => item.id === provider);
  return match?.label || provider;
}

export function authProviderKeyUrl(provider = "") {
  const normalized = normalizeAuthProvider(provider, "");
  const match = [...MAIN_AUTH_PROVIDERS, AUXILIARY_AUTH_PROVIDER].find((item) => item.id === normalized);
  return match?.keyUrl || "";
}

export function authProviderKeyHelp(provider = "") {
  const normalized = normalizeAuthProvider(provider, "");
  const label = providerLabel(normalized);
  const url = authProviderKeyUrl(normalized);
  return url ? `Get ${label} API key: ${url}` : "";
}

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

export async function promptSecret(promptText, { allowEscape = true } = {}) {
  if (!input.isTTY || !output.isTTY) return { value: "", skipped: true };

  if (typeof input.setRawMode === "function") {
    return new Promise((resolve, reject) => {
      emitKeypressEvents(input);
      const wasRaw = Boolean(input.isRaw);
      let value = "";

      const cleanup = () => {
        input.off("keypress", handler);
        if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
        input.pause();
      };

      const finish = (result) => {
        cleanup();
        output.write("\n");
        resolve(result);
      };

      const handler = (str = "", key = {}) => {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(Object.assign(new Error("Interrupted by ctrl-c."), { name: "AbortError", code: "ABORT_ERR" }));
          return;
        }
        if (allowEscape && key.name === "escape") {
          finish({ value: "", skipped: true });
          return;
        }
        if (key.name === "return" || key.name === "enter" || key.sequence === "\r" || str === "\r") {
          finish({ value: value.trim(), skipped: !value.trim() });
          return;
        }
        if (key.name === "backspace" || key.name === "delete") {
          value = value.slice(0, -1);
          return;
        }
        if (key.ctrl || key.meta || key.sequence?.startsWith("\x1b")) return;
        if (str) value += str.replace(/\r|\n/g, "");
      };

      output.write(promptText);
      input.resume();
      input.setRawMode(true);
      input.on("keypress", handler);
    });
  }

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
    const text = String(value || "").trim();
    return { value: text, skipped: !text };
  } finally {
    mutedOutput.muted = false;
    rl.close();
  }
}

export async function promptHidden(promptText) {
  const result = await promptSecret(promptText, { allowEscape: true });
  return typeof result === "string" ? result : result.value || "";
}

function renderProviderPicker({ providers, selected, title, status }) {
  const keyLinks = providers
    .filter((provider) => provider.keyUrl)
    .map((provider) => `${provider.label}: ${provider.keyUrl}`);
  const lines = [
    `\n${title}`,
    "Use Up/Down to choose, Enter to confirm, Esc to go back/skip.",
    `Current key status: ${status}`,
    keyLinks.length ? `API key pages: ${keyLinks.join(" · ")}` : "",
    "",
    ...providers.map((provider, index) => {
      const cursor = index === selected ? ">" : " ";
      return `${cursor} ${provider.label.padEnd(10)} ${provider.keyName.padEnd(16)} ${provider.description}`;
    }),
  ];
  return lines.filter((line, index) => line || index > 2).join("\n");
}

export async function chooseAuthProvider({
  providers = MAIN_AUTH_PROVIDERS,
  title = "Choose main model API key",
  initialProvider = "deepseek",
  projectRoot = process.cwd(),
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    return normalizeAuthProvider(initialProvider, providers[0]?.id || "deepseek");
  }

  return new Promise((resolve, reject) => {
    emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    const status = providerKeyStatus(projectRoot);
    let selected = Math.max(
      providers.findIndex((provider) => provider.id === normalizeAuthProvider(initialProvider, providers[0]?.id)),
      0
    );
    let renderedLines = 0;

    const cleanup = () => {
      input.off("keypress", handler);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      input.pause();
      output.write("\x1b[?25h");
    };

    const clear = () => {
      if (renderedLines <= 0) return;
      output.write(`\x1b[${renderedLines - 1}A`);
      for (let index = 0; index < renderedLines; index += 1) {
        output.write("\r\x1b[2K");
        if (index < renderedLines - 1) output.write("\x1b[1B");
      }
      output.write(`\x1b[${renderedLines - 1}A\r`);
    };

    const render = () => {
      clear();
      const providerStatus = providers
        .map((provider) => `${provider.label}=${status[provider.id] ? "available" : "missing"}`)
        .join(" · ");
      const text = renderProviderPicker({
        providers,
        selected,
        title,
        status: providerStatus,
      });
      const lines = text.split("\n");
      renderedLines = lines.length;
      output.write(`\x1b[?25l${text}`);
    };

    const finish = (value) => {
      clear();
      cleanup();
      resolve(value);
    };

    const handler = (_str = "", key = {}) => {
      if (key.ctrl && key.name === "c") {
        clear();
        cleanup();
        reject(Object.assign(new Error("Interrupted by ctrl-c."), { name: "AbortError", code: "ABORT_ERR" }));
        return;
      }
      if (key.name === "escape") {
        finish("");
        return;
      }
      if (key.name === "up") {
        selected = (selected - 1 + providers.length) % providers.length;
        render();
        return;
      }
      if (key.name === "down") {
        selected = (selected + 1) % providers.length;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.sequence === "\r") {
        finish(providers[selected].id);
      }
    };

    input.resume();
    input.setRawMode(true);
    input.on("keypress", handler);
    render();
  });
}

export function shouldPromptForDeepSeek(args = {}, projectRoot = process.cwd()) {
  const provider = String(args.provider || "").toLowerCase();
  if (provider === "mock" || provider === "openai" || provider === "qwen") return false;
  if (process.env.AGINTIFLOW_NO_AUTH_PROMPT === "1") return false;
  if (!input.isTTY || !output.isTTY) return false;
  const status = providerKeyStatus(projectRoot);
  return !status.deepseek && !status.openai && !status.qwen;
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

export async function runAuthWizard(projectRoot = process.cwd(), options = {}) {
  const status = providerKeyStatus(projectRoot);
  const initialProvider = normalizeAuthProvider(options.provider || options.initialProvider || "deepseek", "deepseek");
  const directProvider =
    options.provider && ["deepseek", "openai", "qwen", "grsai"].includes(normalizeAuthProvider(options.provider, ""))
      ? normalizeAuthProvider(options.provider)
      : "";
  const mainProvider =
    directProvider === "grsai"
      ? ""
      : directProvider ||
        (await chooseAuthProvider({
          projectRoot,
          initialProvider,
          title: "Choose the main model API key to save",
        }));

  const saved = [];
  const skipped = [];

  if (mainProvider) {
    const current = status[mainProvider] ? "currently available; paste a new key to replace, or Esc to keep existing" : "missing";
    const keyHelp = authProviderKeyHelp(mainProvider);
    const prompt = `${keyHelp ? `${keyHelp}\n` : ""}${providerLabel(mainProvider)} main API key (${current}) [hidden]: `;
    const secret = await promptSecret(prompt, { allowEscape: true });
    if (secret.value) {
      const result = await setProviderKey(projectRoot, mainProvider, secret.value);
      saved.push(result);
    } else {
      skipped.push({ provider: mainProvider, reason: secret.skipped ? "skipped" : "empty" });
    }
  } else {
    skipped.push({ provider: "main", reason: "skipped" });
  }

  if (options.includeAuxiliary !== false && directProvider !== "grsai") {
    const auxStatus = providerKeyStatus(projectRoot);
    const current = auxStatus.grsai ? "currently available; paste a new key to replace, or Esc to skip" : "optional; paste key or Esc to skip";
    const secret = await promptSecret(`${AUXILIARY_AUTH_PROVIDER.label} auxiliary image key (${current}) [hidden]: `, {
      allowEscape: true,
    });
    if (secret.value) {
      const result = await setProviderKey(projectRoot, "grsai", secret.value);
      saved.push(result);
    } else {
      skipped.push({ provider: "grsai", reason: "skipped" });
    }
  } else if (directProvider === "grsai") {
    const secret = await promptSecret(`${AUXILIARY_AUTH_PROVIDER.label} auxiliary image key [hidden]: `, {
      allowEscape: true,
    });
    if (secret.value) saved.push(await setProviderKey(projectRoot, "grsai", secret.value));
    else skipped.push({ provider: "grsai", reason: "skipped" });
  }

  return { saved, skipped };
}
