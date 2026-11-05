import OpenAI from "openai";

// Server-owned model configuration selects one canonical endpoint. A redirect
// is not authority to forward prompts, attachments or credentials elsewhere.
// Manual mode preserves the 3xx status, which the SDK does not retry. Retain
// an existing stricter error policy, but never accept implicit/follow mode.
export function createModelHttpClient(options) {
  const redirect = options.fetchOptions?.redirect === "error" ? "error" : "manual";
  const transportFetch = options.fetch || globalThis.fetch;
  return new OpenAI({ ...options, fetchOptions: { ...options.fetchOptions, redirect },
    fetch: async (input, init) => {
      const response = await Reflect.apply(transportFetch, undefined, [input, { ...init, redirect }]);
      if (!isModelHttpRedirect(response)) return response;
      // A redirect body is neither model data nor useful error evidence. Do
      // not wait for it, propagate its Location, or honor retry hints. Native
      // cancellation closes the unconsumed stream; observe its rejection too.
      try { response.body?.cancel().catch(() => {}); } catch { /* already unusable */ }
      return new Response(null, { status: response.status });
    },
  });
}

export function isModelHttpRedirect(error) {
  return Number.isInteger(error?.status) && error.status >= 300 && error.status < 400;
}
