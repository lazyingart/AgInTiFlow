export function assistantText(content) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

export function assistantJsonToolBlock(calls = []) {
  return assistantText(`TOOL_CALLS: \`\`\`json\n${JSON.stringify(calls)}\n\`\`\``);
}

export function toolCall(id, name, args = {}) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

export function assistantTools(...toolCalls) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
        },
      },
    ],
  };
}

export function unsupportedNativeToolsError() {
  const error = new Error("invalid request parameters: tools and tool_choice are unsupported by this fixture model");
  error.status = 400;
  return error;
}

export function unrelatedTransportError() {
  const error = new Error("fixture transport closed before a response was available");
  error.code = "FIXTURE_TRANSPORT_CLOSED";
  return error;
}

export function createScriptedOpenAIClient(script, options = {}) {
  const remaining = [...script];
  const observations = {
    label: options.label || "local-first-agent-eval",
    calls: [],
  };

  const client = {
    fixture: true,
    chat: {
      completions: {
        create: async (payload, requestOptions = {}) => {
          const call = {
            payload,
            requestOptions,
            index: observations.calls.length,
          };
          observations.calls.push(call);
          options.onRequest?.(call);

          if (remaining.length === 0) {
            throw new Error(`${observations.label}: unexpected model request ${observations.calls.length}`);
          }

          const next = remaining.shift();
          if (next instanceof Error) throw next;
          if (typeof next === "function") return await next(call);
          return next;
        },
      },
    },
  };

  return {
    client,
    observations,
    remaining: () => remaining.length,
  };
}
