const form = document.querySelector("#run-form");
const providerField = document.querySelector("#provider");
const modelField = document.querySelector("#model");
const logsEl = document.querySelector("#logs");
const runMetaEl = document.querySelector("#run-meta");
const keyStatusEl = document.querySelector("#key-status");
const sessionSelectEl = document.querySelector("#session-select");
const chatThreadEl = document.querySelector("#chat-thread");
const chatFormEl = document.querySelector("#chat-form");
const chatInputEl = document.querySelector("#chat-input");
const chatStatusEl = document.querySelector("#chat-status");

const defaults = {
  openai: "gpt-5.4-mini",
  deepseek: "deepseek-chat",
};

let currentSessionId = "";
let pollTimer = null;
let saveTimer = null;

function formPayload() {
  return {
    provider: providerField.value,
    model: modelField.value.trim(),
    startUrl: document.querySelector("#startUrl").value.trim(),
    allowedDomains: document.querySelector("#allowedDomains").value.trim(),
    commandCwd: document.querySelector("#commandCwd").value.trim(),
    maxSteps: Number(document.querySelector("#maxSteps").value) || 15,
    headless: document.querySelector("#headless").checked,
    allowShellTool: document.querySelector("#allowShellTool").checked,
    useDockerSandbox: document.querySelector("#useDockerSandbox").checked,
    dockerSandboxImage: document.querySelector("#dockerSandboxImage").value.trim(),
    allowPasswords: document.querySelector("#allowPasswords").checked,
    allowDestructive: document.querySelector("#allowDestructive").checked,
  };
}

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

function renderChat(chatEntries) {
  if (!chatEntries || chatEntries.length === 0) {
    chatThreadEl.innerHTML = '<div class="subtle">No conversation loaded.</div>';
    return;
  }

  chatThreadEl.innerHTML = chatEntries
    .map((entry) => {
      const role = entry.role === "assistant" ? "assistant" : "user";
      const label = role === "assistant" ? "Assistant" : "You";
      const content = (entry.content || "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
      return `
        <article class="chat-item ${role}">
          <div class="chat-meta">${label}${entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ""}</div>
          <div class="chat-content">${content.replace(/\n/g, "<br>")}</div>
        </article>
      `;
    })
    .join("");

  chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
}

function renderSessions(sessions) {
  const current = sessionSelectEl.value;
  const options = ['<option value="">Select a recent session</option>']
    .concat(
      (sessions || []).map((session) => {
        const label = `${session.provider} · ${session.goal.slice(0, 60)}${session.goal.length > 60 ? "..." : ""}`;
        return `<option value="${session.sessionId}">${label}</option>`;
      })
    )
    .join("");

  sessionSelectEl.innerHTML = options;
  if (current && [...sessionSelectEl.options].some((opt) => opt.value === current)) {
    sessionSelectEl.value = current;
  }
}

async function refreshSessions() {
  const response = await fetch("/api/sessions");
  const data = await response.json();
  renderSessions(data.sessions || []);
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
    await refreshChat();
    await refreshSessions();
  }
}

async function refreshChat() {
  if (!currentSessionId) {
    renderChat([]);
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/chat`);
  if (!response.ok) {
    renderChat([]);
    return;
  }

  const data = await response.json();
  renderChat(data.chat || []);
}

async function savePreferences() {
  await fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formPayload()),
  });
}

function schedulePreferenceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePreferences().catch(() => {});
  }, 250);
}

providerField.addEventListener("change", () => {
  if (!modelField.value.trim() || modelField.value === defaults.openai || modelField.value === defaults.deepseek) {
    modelField.value = defaults[providerField.value] || "";
  }
  schedulePreferenceSave();
});

form.addEventListener("input", schedulePreferenceSave);
form.addEventListener("change", schedulePreferenceSave);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const goal = document.querySelector("#goal").value.trim();
  if (!goal) {
    logsEl.textContent = "Goal is required.";
    return;
  }

  const payload = {
    ...formPayload(),
    goal,
  };

  logsEl.textContent = "Starting run...";
  runMetaEl.textContent = "";
  chatStatusEl.textContent = "";

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
  sessionSelectEl.value = currentSessionId;
  runMetaEl.textContent = `running · ${currentSessionId}`;
  await refreshSessions();
  await refreshChat();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

sessionSelectEl.addEventListener("change", async () => {
  currentSessionId = sessionSelectEl.value;
  if (!currentSessionId) {
    runMetaEl.textContent = "";
    logsEl.textContent = "No run selected.";
    renderChat([]);
    return;
  }
  await refreshRun();
  await refreshChat();
});

chatFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentSessionId) {
    chatStatusEl.textContent = "Select or start a session first.";
    return;
  }

  const content = chatInputEl.value.trim();
  if (!content) {
    chatStatusEl.textContent = "Message is required.";
    return;
  }

  chatStatusEl.textContent = "Sending...";

  const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...formPayload(),
      content,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    chatStatusEl.textContent = data.error || "Failed to continue the conversation.";
    return;
  }

  currentSessionId = data.sessionId;
  chatInputEl.value = "";
  chatStatusEl.textContent = "Running...";
  await refreshSessions();
  await refreshChat();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRun, 1500);
  await refreshRun();
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const data = await response.json();
  const prefs = data.preferences || {};

  providerField.value = prefs.provider || "deepseek";
  modelField.value = prefs.model || defaults[providerField.value] || "deepseek-chat";
  document.querySelector("#startUrl").value = prefs.startUrl || "";
  document.querySelector("#allowedDomains").value = prefs.allowedDomains || "";
  document.querySelector("#commandCwd").value = prefs.commandCwd || "/home/lachlan/ProjectsLFS/Agent";
  document.querySelector("#headless").checked = prefs.headless ?? data.defaults.headless;
  document.querySelector("#maxSteps").value = prefs.maxSteps ?? data.defaults.maxSteps;
  document.querySelector("#allowShellTool").checked = prefs.allowShellTool ?? true;
  document.querySelector("#useDockerSandbox").checked = prefs.useDockerSandbox ?? false;
  document.querySelector("#dockerSandboxImage").value = prefs.dockerSandboxImage || "agintiflow-sandbox:latest";
  document.querySelector("#allowPasswords").checked = prefs.allowPasswords ?? false;
  document.querySelector("#allowDestructive").checked = prefs.allowDestructive ?? false;

  keyStatusEl.textContent = `Keys: OpenAI ${data.keyStatus.openai ? "available" : "missing"} · DeepSeek ${data.keyStatus.deepseek ? "available" : "missing"}`;

  renderSessions(data.sessions || []);
  if (data.sessions && data.sessions.length > 0) {
    currentSessionId = data.sessions[0].sessionId;
    sessionSelectEl.value = currentSessionId;
    await refreshRun();
    await refreshChat();
  }
}

loadConfig().catch((error) => {
  logsEl.textContent = String(error);
});
