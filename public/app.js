const form = document.querySelector("#run-form");
const providerField = document.querySelector("#provider");
const modelField = document.querySelector("#model");
const logsEl = document.querySelector("#logs");
const runMetaEl = document.querySelector("#run-meta");
const keyStatusEl = document.querySelector("#key-status");

const defaults = {
  openai: "gpt-5.4-mini",
  deepseek: "deepseek-chat",
};

let currentSessionId = "";
let pollTimer = null;

function renderLogs(run) {
  const lines = [];
  lines.push(`status=${run.status} session=${run.sessionId} provider=${run.provider} model=${run.model}`);
  if (run.result) lines.push(`result=${run.result}`);
  if (run.error) lines.push(`error=${run.error}`);
  lines.push("");

  for (const entry of run.logs || []) {
    lines.push(`[${entry.at}] ${entry.kind}: ${entry.message}`);
    if (entry.data && Object.keys(entry.data).length > 0) {
      lines.push(JSON.stringify(entry.data, null, 2));
    }
    lines.push("");
  }

  logsEl.textContent = lines.join("\n");
}

async function refreshRun() {
  if (!currentSessionId) return;
  const response = await fetch(`/api/runs/${encodeURIComponent(currentSessionId)}`);
  if (!response.ok) return;
  const run = await response.json();
  runMetaEl.textContent = `${run.status} · ${run.sessionId}`;
  renderLogs(run);

  if (run.status === "finished" || run.status === "failed") {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

providerField.addEventListener("change", () => {
  modelField.value = defaults[providerField.value] || "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    provider: providerField.value,
    model: modelField.value.trim(),
    goal: document.querySelector("#goal").value.trim(),
    startUrl: document.querySelector("#startUrl").value.trim(),
    allowedDomains: document.querySelector("#allowedDomains").value.trim(),
    commandCwd: document.querySelector("#commandCwd").value.trim(),
    maxSteps: Number(document.querySelector("#maxSteps").value) || 15,
    headless: document.querySelector("#headless").checked,
    allowShellTool: document.querySelector("#allowShellTool").checked,
    allowPasswords: document.querySelector("#allowPasswords").checked,
    allowDestructive: document.querySelector("#allowDestructive").checked,
  };

  logsEl.textContent = "Starting run...";
  runMetaEl.textContent = "";

  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    logsEl.textContent = data.error || "Failed to start run.";
    return;
  }

  currentSessionId = data.sessionId;
  runMetaEl.textContent = `running · ${currentSessionId}`;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const data = await response.json();
  document.querySelector("#headless").checked = data.defaults.headless;
  document.querySelector("#maxSteps").value = data.defaults.maxSteps;
  keyStatusEl.textContent = `Keys: OpenAI ${data.keyStatus.openai ? "available" : "missing"} · DeepSeek ${data.keyStatus.deepseek ? "available" : "missing"}`;
}

loadConfig().catch((error) => {
  logsEl.textContent = String(error);
});
