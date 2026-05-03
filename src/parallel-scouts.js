import { engineeringGuidanceForTask } from "./engineering-guidance.js";
import { getModelPresets } from "./model-routing.js";
import { getTaskProfile, normalizeTaskProfile } from "./task-profiles.js";
import { redactSensitiveText } from "./redaction.js";
import { refreshCodebaseMap } from "./codebase-map.js";

const MAX_CONTEXT_PACK_CHARS = 3800;
const MAX_SCOUT_CONTENT_CHARS = 1200;

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
  {
    name: "symbol-tracer",
    prompt:
      "Infer likely symbols, APIs, routes, commands, schemas, or config keys that connect the change. Suggest exact searches before editing.",
  },
  {
    name: "dependency-doctor",
    prompt:
      "Identify dependency, environment, package-manager, Docker, and generated-artifact risks. Prefer project-local or sandboxed setup and focused verification.",
  },
];

export function listParallelScouts() {
  return SCOUTS.map((scout) => ({ name: scout.name, prompt: scout.prompt }));
}

function shouldUseComplexScouts(config, state) {
  const profile = normalizeTaskProfile(config.taskProfile);
  const goal = String(config.goal || state.goal || "");
  return (
    Number(config.routeComplexityScore || 0) >= 3 ||
    ["large-codebase", "maintenance", "code", "qa", "database", "devops", "security", "github"].includes(profile) ||
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

function truncateText(text, limit = MAX_CONTEXT_PACK_CHARS) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 80)}\n... [truncated ${value.length - limit + 80} chars]`;
}

async function buildScoutContextPack(config) {
  if (!config.allowFileTools) {
    return {
      text: "Context pack: workspace file tools are disabled. Scouts should recommend the minimal inspection commands/files instead of assuming repository structure.",
      codebaseMap: null,
    };
  }

  try {
    const refreshed = await refreshCodebaseMap(config, { maxDepth: 4, limit: 1000, includeFiles: false });
    if (!refreshed?.ok) {
      return {
        text: `Context pack: inspect_project unavailable (${refreshed?.reason || refreshed?.error || "unknown error"}).`,
        codebaseMap: null,
      };
    }
    return {
      text: truncateText(redactSensitiveText(refreshed.contextPack || "")),
      codebaseMap: {
        path: refreshed.path,
        generatedAt: refreshed.map.generatedAt,
        fingerprint: refreshed.map.fingerprint,
        summary: refreshed.map.inspection?.summary || "",
      },
    };
  } catch (error) {
    return {
      text: `Context pack: inspect_project failed (${redactSensitiveText(error instanceof Error ? error.message : String(error))}).`,
      codebaseMap: null,
    };
  }
}

function capScoutContent(content) {
  return truncateText(redactSensitiveText(content || "").trim(), MAX_SCOUT_CONTENT_CHARS);
}

function scoutMessages(config, state, scout, contextPack) {
  const profile = getTaskProfile(config.taskProfile);
  const guidance = engineeringGuidanceForTask(config.goal || state.goal || "", config.taskProfile);
  return [
    {
      role: "system",
      content:
        "You are a parallel scout for AgInTiFlow. Your answer is advisory only: do not claim work is done, do not ask questions, do not use tools, and keep under 180 words. Work from the shared context pack and state dependencies on other scout roles when relevant.",
    },
    {
      role: "user",
      content: [
        `Scout role: ${scout.name}`,
        scout.prompt,
        `Shared context pack:\n${contextPack}`,
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

async function synthesizeScouts(client, config, model, scouts, contextPack) {
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
            "You synthesize parallel coding-agent scout notes into a Swarm Board. Produce under 320 words with: shared context, execution order, conflicts/unknowns, must-read files/checks, and stop conditions. Prefer concrete paths/commands from the context pack. Do not claim work is done.",
        },
        {
          role: "user",
          content: [`## shared context pack\n${contextPack}`, ...usable.map((scout) => `## ${scout.name}\n${scout.content}`)].join(
            "\n\n"
          ),
        },
      ],
    },
    config.abortSignal ? { signal: config.abortSignal } : undefined
  );
  return redactSensitiveText(response.choices[0]?.message?.content || "").trim();
}

function extractFindings(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
    .filter((line) => line && line.length > 8)
    .slice(0, 6);
}

function buildScoutBlackboard({ config, state, model, requested, completed, scouts, contextPack, codebaseMap, synthesis }) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    goal: config.goal || state.goal || "",
    model,
    requested,
    completed,
    codebaseMap,
    contextPack,
    coordinator: synthesis || "",
    lanes: scouts.map((scout) => ({
      role: scout.name,
      model: scout.model || model,
      status: scout.content ? "completed" : "failed",
      findings: scout.content ? extractFindings(scout.content) : [],
      content: scout.content || "",
      error: scout.error || "",
    })),
    handoff:
      "Use this blackboard as advisory shared context. The executor must still inspect exact files, patch deterministically, run focused checks, and stop on conflicts or unrelated dirty work.",
  };
}

export async function runParallelScouts(client, config, state) {
  const count = Math.min(Math.max(Number(config.parallelScoutCount) || 3, 1), SCOUTS.length);
  const selected = SCOUTS.slice(0, count);
  const model = scoutModel(config);
  const context = await buildScoutContextPack(config);
  const contextPack = context.text;
  const settled = await Promise.allSettled(
    selected.map(async (scout) => {
      const response = await client.chat.completions.create(
        {
          model,
          temperature: 0,
          messages: scoutMessages(config, state, scout, contextPack),
        },
        config.abortSignal ? { signal: config.abortSignal } : undefined
      );
      return {
        name: scout.name,
        model,
        content: capScoutContent(response.choices[0]?.message?.content || ""),
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
      ? await synthesizeScouts(client, config, model, scouts, contextPack).catch((error) =>
          `Synthesis failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
        )
      : "";
  const summary = [
    "Parallel scout swarm notes. Treat these as advisory shared context, not completed work.",
    `\n## shared context pack\n${contextPack}`,
    synthesis ? `\n## coordinator\n${synthesis}` : "",
    ...scouts.map((scout) =>
      scout.content ? `\n## ${scout.name}\n${scout.content}` : `\n## ${scout.name}\nScout failed: ${scout.error || "unknown error"}`
    ),
  ]
    .filter(Boolean)
    .join("\n");
  const blackboard = buildScoutBlackboard({
    config,
    state,
    model,
    requested: selected.length,
    completed,
    scouts,
    contextPack,
    codebaseMap: context.codebaseMap,
    synthesis,
  });

  return {
    ok: completed > 0,
    model,
    requested: selected.length,
    completed,
    scouts,
    contextPack,
    codebaseMap: context.codebaseMap,
    blackboard,
    synthesis,
    summary,
  };
}
