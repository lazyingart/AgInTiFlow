import { hasAgintiEvidenceScope, scopedChatopsEvidenceGoal } from "./scs-evidence.js";

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || part?.content || "").filter(Boolean).join("\n");
}

const RUNTIME_USER_MESSAGE_PATTERNS = Object.freeze([
  /^Step \d+\/\d+\b.*Latest runtime snapshot:/i,
  /^Retained runtime tool evidence\./i,
  /^The runtime proactively compacted a long agent history/i,
  /^A previous agent-step model request timed out/i,
  /^Continue from this compacted, valid transcript/i,
  /^Previous assistant response retained as compacted history/i,
  /^Highest-priority retained state:/i,
  /^Bounded failed-test evidence packet(?: v\d+)?\./i,
  /^Verification is still failing,/i,
  /^The previous tool-call batch was rejected before dispatch\./i,
  /^Loop guard:/i,
  /^Runtime phase transition:/i,
]);

function isRuntimeUserMessage(content = "") {
  const text = String(content || "").trim();
  return RUNTIME_USER_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}

function genuineUserMessages(messages = []) {
  return messages.filter(
    (message) => message?.role === "user" && !isRuntimeUserMessage(messageText(message.content))
  );
}

export function hasExplicitDeepResearchIntent(goal = "", messages = []) {
  const recent = hasAgintiEvidenceScope(goal)
    ? ""
    : genuineUserMessages(messages)
        .slice(-4)
        .map((message) => scopedChatopsEvidenceGoal(messageText(message.content)))
        .join("\n");
  const text = `${scopedChatopsEvidenceGoal(goal)}\n${recent}`.toLowerCase();
  return (
    /\b(deep (?:web )?research|literature review|systematic review|multi[- ]source research|evidence review)\b/i.test(text) ||
    /\b(research report|compare at least|independent (?:primary|scholarly|official) sources?)\b.{0,160}\b(primary|scholarly|papers?|pdf|citations?|evidence|sources?)\b/i.test(text) ||
    /\b(primary|scholarly|papers?|pdf|citations?|evidence|sources?)\b.{0,160}\b(research report|compare at least|independent sources?)\b/i.test(text) ||
    /(深入研究|深度研究|文献综述|系统综述|多来源研究|证据综述|文獻綜述|システマティックレビュー|文献レビュー)/u.test(text)
  );
}

export function hasLocalResearchWorkspaceIntent(goal = "", messages = []) {
  const recent = hasAgintiEvidenceScope(goal)
    ? ""
    : genuineUserMessages(messages)
        .slice(-4)
        .map((message) => scopedChatopsEvidenceGoal(messageText(message.content)))
        .join("\n");
  const text = `${scopedChatopsEvidenceGoal(goal)}\n${recent}`;
  return (
    /\b(?:this|current|existing|project|workspace|local)\s+(?:folder|directory|repo(?:sitory)?|files?|notes?|sources?|artifacts?)\b/i.test(text) ||
    /\b(?:task|project|source|research|evidence|notes?|manifest|readme)[-_A-Za-z0-9]*\.(?:md|json|ya?ml|txt|csv|bib|tex)\b/i.test(text) ||
    /\b(?:inspect|read|reconcile|correct|rewrite|update)\b.{0,120}\b(?:workspace|folder|directory|repo(?:sitory)?|local files?|project notes?|existing notes?)\b/i.test(text) ||
    /\b(?:git\s+)?commit\b/i.test(text)
  );
}

export function toolWasRequested(messages = [], toolName = "") {
  return messages.some((message) => {
    if (
      message?.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.function?.name === toolName)
    ) {
      return true;
    }
    if (message?.role !== "user") return false;
    const content = messageText(message.content);
    if (!/^Retained runtime tool evidence\./i.test(content.trim())) return false;
    return new RegExp(`^Tool:\\s*${String(toolName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(content);
  });
}

export function shouldStartWithDeepResearch(goal = "", messages = []) {
  return (
    hasExplicitDeepResearchIntent(goal, messages) &&
    !hasLocalResearchWorkspaceIntent(goal, messages) &&
    !toolWasRequested(messages, "deep_research")
  );
}
