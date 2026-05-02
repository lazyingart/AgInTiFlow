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
  {
    name: "cartographer",
    prompt:
      "Design a compact context map: key instructions, manifests, entry points, tests, symbols, and files the executor should read. Avoid dumping a full tree.",
  },
  {
    name: "tester",
    prompt:
      "Identify the narrowest checks to run first, then broader checks. Include likely setup blockers and how to validate without wasting steps.",
  },
  {
    name: "git-operator",
    prompt:
      "If git is relevant, outline the safe git sequence: status/diff first, commit boundaries, fetch/pull --ff-only, push, and stop conditions.",
  },
  {
    name: "integrator",
    prompt:
      "Look across workstreams for conflicts, shared files, ordering constraints, and what each scout might be missing. Keep it execution-focused.",
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
        state.meta?.projectInstructions?.exists
          ? `Project instructions: AGINTI.md loaded from ${state.meta.projectInstructions.path}${state.meta.projectInstructions.truncated ? " (truncated)" : ""}.`
          : "Project instructions: AGINTI.md not present.",
        `Workspace: ${config.commandCwd}`,
        `Sandbox: ${config.sandboxMode}; package policy: ${config.packageInstallPolicy}`,
        `Current plan:\n${state.plan || "(none yet)"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

async function synthesizeScouts(client, config, model, scouts) {
  const usable = scouts.filter((scout) => scout.content);
  if (usable.length < 2) return "";
  const response = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You synthesize parallel coding-agent scout notes. Produce a compact execution brief under 220 words. Resolve conflicts, identify shared context, and list stop conditions. Do not claim work is done.",
        },
        {
          role: "user",
          content: usable.map((scout) => `## ${scout.name}\n${scout.content}`).join("\n\n"),
        },
      ],
    },
    config.abortSignal ? { signal: config.abortSignal } : undefined
  );
  return redactSensitiveText(response.choices[0]?.message?.content || "").trim();
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
  const synthesis =
    completed > 1
      ? await synthesizeScouts(client, config, model, scouts).catch((error) =>
          `Synthesis failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
        )
      : "";
  const summary = [
    "Parallel scout notes. Treat these as advisory, not completed work.",
    synthesis ? `\n## coordinator\n${synthesis}` : "",
    ...scouts.map((scout) =>
      scout.content ? `\n## ${scout.name}\n${scout.content}` : `\n## ${scout.name}\nScout failed: ${scout.error || "unknown error"}`
    ),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ok: completed > 0,
    model,
    requested: selected.length,
    completed,
    scouts,
    synthesis,
    summary,
  };
}
