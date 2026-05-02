import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import { providerKeyPreview, providerKeyStatus, setProviderKey } from "./project.js";

const useColor = Boolean(input.isTTY && output.isTTY && process.env.AGINTIFLOW_NO_COLOR !== "1");
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  selected: "\x1b[48;5;31m\x1b[38;5;231m",
  border: "\x1b[38;5;45m",
  muted: "\x1b[38;5;245m",
  inputBg: "\x1b[48;5;236m\x1b[38;5;231m",
  clearLine: "\x1b[2K",
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
};

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

function color(value, ...codes) {
  if (!useColor || codes.length === 0) return String(value);
  return `${codes.join("")}${value}${ansi.reset}`;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function terminalWidth() {
  return Math.max(Number(output.columns) || 80, 50);
}

function padVisible(value, width) {
  return `${value}${" ".repeat(Math.max(width - visibleLength(value), 0))}`;
}

function compactLine(value = "", limit = 92) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}…`;
}

function boxedLine(content, width) {
  return `${color("│", ansi.border)} ${padVisible(content, width - 4)} ${color("│", ansi.border)}`;
}

function secretInputDisplay({ value, selectedPreview, placeholder }) {
  if (value) return color(`${"•".repeat(Math.min(value.length, 24))} (${value.length} chars)`, ansi.inputBg);
  if (selectedPreview) return `${color(` ${selectedPreview} `, ansi.selected, ansi.bold)} ${color("selected", ansi.yellow)}`;
  return color(placeholder || "paste key here", ansi.dim);
}

function renderSecretBox({ title, helpText, statusText, currentPreview, value, selected, actionText }) {
  const width = Math.min(Math.max(terminalWidth() - 2, 58), 96);
  const inner = width - 4;
  const selectedPreview = selected && currentPreview ? currentPreview : "";
  const lines = [
    `${color("╭", ansi.border)}${color("─", ansi.border).repeat(width - 2)}${color("╮", ansi.border)}`,
    boxedLine(color(compactLine(title, inner), ansi.bold, ansi.cyan), width),
    helpText ? boxedLine(`${color("key", ansi.muted)}   ${compactLine(helpText, inner - 6)}`, width) : "",
    statusText ? boxedLine(`${color("status", ansi.muted)} ${compactLine(statusText, inner - 8)}`, width) : "",
    boxedLine(`${color("input", ansi.muted)}  ${secretInputDisplay({ value, selectedPreview, placeholder: "hidden input" })}`, width),
    boxedLine(color(compactLine(actionText, inner), ansi.dim), width),
    `${color("╰", ansi.border)}${color("─", ansi.border).repeat(width - 2)}${color("╯", ansi.border)}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function clearRenderedLines(count) {
  if (!count) return;
  output.write(`\x1b[${count - 1}A`);
  for (let index = 0; index < count; index += 1) {
    output.write(`\r${ansi.clearLine}`);
    if (index < count - 1) output.write("\x1b[1B");
  }
  output.write(`\x1b[${count - 1}A\r`);
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

export async function promptSecret(promptText, { allowEscape = true, box = null } = {}) {
  if (!input.isTTY || !output.isTTY) return { value: "", skipped: true };

  if (typeof input.setRawMode === "function") {
    return new Promise((resolve, reject) => {
      emitKeypressEvents(input);
      const wasRaw = Boolean(input.isRaw);
      let value = "";
      let selectedExisting = Boolean(box?.currentPreview);
      let renderedLines = 0;

      const render = () => {
        if (!box) return;
        clearRenderedLines(renderedLines);
        const text = renderSecretBox({
          ...box,
          value,
          selected: selectedExisting,
        });
        renderedLines = text.split("\n").length;
        output.write(`${ansi.cursorHide}${text}`);
      };

      const cleanup = () => {
        input.off("keypress", handler);
        if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
        input.pause();
        output.write(ansi.cursorShow);
      };

      const finish = (result) => {
        if (box) clearRenderedLines(renderedLines);
        cleanup();
        if (!box) output.write("\n");
        resolve(result);
      };

      const handler = (str = "", key = {}) => {
        if (key.ctrl && key.name === "c") {
          if (box) clearRenderedLines(renderedLines);
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
          if (selectedExisting) {
            selectedExisting = false;
            value = "";
          } else {
            value = value.slice(0, -1);
          }
          render();
          return;
        }
        if (key.ctrl && key.name === "u") {
          selectedExisting = false;
          value = "";
          render();
          return;
        }
        if (key.ctrl || key.meta || key.sequence?.startsWith("\x1b")) return;
        if (str) {
          if (selectedExisting) {
            selectedExisting = false;
            value = "";
          }
          value += str.replace(/\r|\n/g, "");
          render();
        }
      };

      if (box) render();
      else output.write(promptText);
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
    const preview = providerKeyPreview(projectRoot, mainProvider);
    const current = preview.available ? `available: ${preview.preview}` : "missing";
    const keyHelp = authProviderKeyHelp(mainProvider);
    const title = `${providerLabel(mainProvider)} main API key`;
    const prompt = `${keyHelp ? `${keyHelp}\n` : ""}${title} (${current}) [hidden]: `;
    const secret = await promptSecret(prompt, {
      allowEscape: true,
      box: {
        title,
        helpText: keyHelp || "Paste the provider API key.",
        statusText: preview.available ? `Existing ${preview.keyName}: ${preview.preview}` : `Missing ${preview.keyName || "provider key"}`,
        currentPreview: preview.preview,
        actionText: preview.available
          ? "Existing key is selected. Type to replace, Enter/Esc to keep existing."
          : "Paste key and Enter to save, or Esc/Enter to skip.",
      },
    });
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
    const preview = providerKeyPreview(projectRoot, "grsai");
    const current = preview.available ? `available: ${preview.preview}` : "optional";
    const title = `${AUXILIARY_AUTH_PROVIDER.label} auxiliary image key`;
    const secret = await promptSecret(`${title} (${current}) [hidden]: `, {
      allowEscape: true,
      box: {
        title,
        helpText: "Optional image generation key for GRS AI / Nano Banana.",
        statusText: preview.available ? `Existing ${preview.keyName}: ${preview.preview}` : "Optional; no auxiliary key saved.",
        currentPreview: preview.preview,
        actionText: preview.available ? "Existing key is selected. Type to replace, Enter/Esc to keep existing." : "Paste key and Enter to save, or Esc/Enter to skip.",
      },
    });
    if (secret.value) {
      const result = await setProviderKey(projectRoot, "grsai", secret.value);
      saved.push(result);
    } else {
      skipped.push({ provider: "grsai", reason: "skipped" });
    }
  } else if (directProvider === "grsai") {
    const preview = providerKeyPreview(projectRoot, "grsai");
    const title = `${AUXILIARY_AUTH_PROVIDER.label} auxiliary image key`;
    const secret = await promptSecret(`${title} [hidden]: `, {
      allowEscape: true,
      box: {
        title,
        helpText: "Optional image generation key for GRS AI / Nano Banana.",
        statusText: preview.available ? `Existing ${preview.keyName}: ${preview.preview}` : "Missing auxiliary key.",
        currentPreview: preview.preview,
        actionText: preview.available ? "Existing key is selected. Type to replace, Enter/Esc to keep existing." : "Paste key and Enter to save, or Esc/Enter to skip.",
      },
    });
    if (secret.value) saved.push(await setProviderKey(projectRoot, "grsai", secret.value));
    else skipped.push({ provider: "grsai", reason: "skipped" });
  }

  return { saved, skipped };
}
