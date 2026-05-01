import { engineeringGuidanceForTask } from "./engineering-guidance.js";
import { getModelPresets } from "./model-routing.js";
import { getTaskProfile, normalizeTaskProfile } from "./task-profiles.js";
import { redactSensitiveText } from "./redaction.js";

const SCOUTS = [
  {
    name: "architect",
    prompt:
      "Decompose the task into independent workstreams. Identify the first files, manifests, logs, or commands the executor should inspect. Keep it actionable.",
  },
  {
    name: "implementer",
    prompt:
      "Predict the most likely implementation path across languages/toolchains. Suggest patch boundaries and focused checks. Avoid writing full code.",
  },
  {
    name: "reviewer",
    prompt:
      "Find instruction-compliance risks, missing tests, system/environment pitfalls, and stop conditions. Suggest how to avoid loops.",
  },
  {
    name: "researcher",
    prompt:
      "If current external information may matter, suggest exact web_search queries and source types. Otherwise say no web search needed.",
  },
];

function shouldUseComplexScouts(config, state) {
  const profile = normalizeTaskProfile(config.taskProfile);
  const goal = String(config.goal || state.goal || "");
  return (
    Number(config.routeComplexityScore || 0) >= 3 ||
    ["large-codebase", "maintenance", "code"].includes(profile) ||
    /\b(large|complex|complicated|debug|bug|failing|system|install|setup|codebase|repo|multi[- ]file|architecture|refactor|migration)\b/i.test(
      goal
    )
  );
}

export function shouldRunParallelScouts(config, state) {
  if (config.allowParallelScouts === false) return false;
  if (config.provider === "mock") return false;
  if (state?.meta?.parallelScoutsCompleted) return false;
  return shouldUseComplexScouts(config, state || {});
}

function scoutModel(config) {
  if (config.provider === "deepseek") return getModelPresets().fast.model;
  return config.model;
}

function scoutMessages(config, state, scout) {
  const profile = getTaskProfile(config.taskProfile);
  const guidance = engineeringGuidanceForTask(config.goal || state.goal || "", config.taskProfile);
  return [
    {
      role: "system",
      content:
        "You are a parallel scout for AgInTiFlow. Your answer is advisory only: do not claim work is done, do not ask questions, do not use tools, and keep under 180 words.",
    },
    {
      role: "user",
      content: [
        `Scout role: ${scout.name}`,
        scout.prompt,
        `Goal: ${config.goal || state.goal || ""}`,
        `Task profile: ${profile.label}. ${profile.prompt}`,
        guidance,
        `Workspace: ${config.commandCwd}`,
        `Sandbox: ${config.sandboxMode}; package policy: ${config.packageInstallPolicy}`,
        `Current plan:\n${state.plan || "(none yet)"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

export async function runParallelScouts(client, config, state) {
  const count = Math.min(Math.max(Number(config.parallelScoutCount) || 3, 1), SCOUTS.length);
  const selected = SCOUTS.slice(0, count);
  const model = scoutModel(config);
  const settled = await Promise.allSettled(
    selected.map(async (scout) => {
      const response = await client.chat.completions.create(
        {
          model,
          temperature: 0,
          messages: scoutMessages(config, state, scout),
        },
        config.abortSignal ? { signal: config.abortSignal } : undefined
      );
      return {
        name: scout.name,
        model,
        content: redactSensitiveText(response.choices[0]?.message?.content || "").trim(),
      };
    })
  );

  const scouts = settled.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    return {
      name: selected[index]?.name || `scout-${index + 1}`,
      model,
      error: redactSensitiveText(item.reason instanceof Error ? item.reason.message : String(item.reason)),
    };
  });
  const completed = scouts.filter((scout) => scout.content).length;
  const summary = [
    "Parallel scout notes. Treat these as advisory, not completed work.",
    ...scouts.map((scout) =>
      scout.content ? `\n## ${scout.name}\n${scout.content}` : `\n## ${scout.name}\nScout failed: ${scout.error || "unknown error"}`
    ),
  ].join("\n");

  return {
    ok: completed > 0,
    model,
    requested: selected.length,
    completed,
    scouts,
    summary,
  };
}
