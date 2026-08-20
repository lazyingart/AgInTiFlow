function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text || part?.content || "").filter(Boolean).join("\n");
}

export function hasExplicitDeepResearchIntent(goal = "", messages = []) {
  const recent = messages
    .filter((message) => message?.role === "user")
    .slice(-4)
    .map((message) => messageText(message.content))
    .join("\n");
  const text = `${String(goal || "")}\n${recent}`.toLowerCase();
  return (
    /\b(deep (?:web )?research|literature review|systematic review|multi[- ]source research|evidence review)\b/i.test(text) ||
    /\b(research report|compare at least|independent (?:primary|scholarly|official) sources?)\b.{0,160}\b(primary|scholarly|papers?|pdf|citations?|evidence|sources?)\b/i.test(text) ||
    /\b(primary|scholarly|papers?|pdf|citations?|evidence|sources?)\b.{0,160}\b(research report|compare at least|independent sources?)\b/i.test(text) ||
    /(深入研究|深度研究|文献综述|系统综述|多来源研究|证据综述|文獻綜述|システマティックレビュー|文献レビュー)/u.test(text)
  );
}

export function toolWasRequested(messages = [], toolName = "") {
  return messages.some(
    (message) =>
      message?.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.function?.name === toolName)
  );
}

export function shouldStartWithDeepResearch(goal = "", messages = []) {
  return hasExplicitDeepResearchIntent(goal, messages) && !toolWasRequested(messages, "deep_research");
}
