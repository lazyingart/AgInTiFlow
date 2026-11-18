// Token ceilings belong to the caller. Translate their wire name only for
// the selected GPT-5 Chat Completions route.
export function withChatTokenBudget(provider, body) {
  if (provider !== "openai" || !/^gpt-5(?:[.-]|$)/.test(body.model) || !Object.hasOwn(body, "max_tokens")) return body;
  const { max_tokens, ...rest } = body;
  if (Object.hasOwn(rest, "max_completion_tokens") && rest.max_completion_tokens !== max_tokens) {
    throw new Error("Conflicting chat completion token budgets.");
  }
  return { ...rest, max_completion_tokens: max_tokens };
}
