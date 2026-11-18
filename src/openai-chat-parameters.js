// Token ceilings belong to the caller. GPT-6 Sol/Astra support text Chat
// Completions; function calls on these models require the Responses API.
export function usesResponsesToolModel(provider, model) {
  return provider === "openai" && /^(?:gpt-6\.1-sol|gpt-6\.2-(?:sol|astra))(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
}

export function hasToolConversation(body) {
  return Boolean((body.tools != null && (!Array.isArray(body.tools) || body.tools.length)) ||
    (body.functions != null && (!Array.isArray(body.functions) || body.functions.length)) ||
    (body.tool_choice != null && body.tool_choice !== "none") ||
    (body.function_call != null && body.function_call !== "none") ||
    body.messages?.some(message => ["tool", "function"].includes(message.role) || message.tool_calls?.length || message.function_call));
}

export function withChatTokenBudget(provider, body) {
  if (provider !== "openai") return body;
  const textOnlyChat = usesResponsesToolModel(provider, body.model);
  if (textOnlyChat) {
    if (hasToolConversation(body)) {
      throw Object.assign(new Error("This OpenAI model requires the Responses API for tool calls."), { code: "OPENAI_RESPONSES_TOOLS_REQUIRED" });
    }
    const { temperature, top_p, logprobs, top_logprobs, tools, functions, tool_choice, function_call, parallel_tool_calls, ...supported } = body;
    body = supported;
  }
  if ((!textOnlyChat && !/^gpt-5(?:[.-]|$)/.test(body.model)) || !Object.hasOwn(body, "max_tokens")) return body;
  const { max_tokens, ...rest } = body;
  if (Object.hasOwn(rest, "max_completion_tokens") && rest.max_completion_tokens !== max_tokens) {
    throw new Error("Conflicting chat completion token budgets.");
  }
  return { ...rest, max_completion_tokens: max_tokens };
}
