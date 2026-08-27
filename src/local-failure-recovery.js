import { LOCALLLM_MODEL_TIERS, localLLMModelTier } from "./model-routing.js";
import { normalizeProviderId } from "./provider-contract.js";

const RECOVERABLE_TOOL_NAMES = new Set([
  "apply_patch",
  "write_file",
  "run_command",
]);

const STRONG_LOCAL_TIERS = new Set(["deep", "code"]);

function safeModel(value = "") {
  const model = String(value || "").trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) return "";
  return model;
}

function recoverableFailureWindow(state = {}) {
  const recent = Array.isArray(state.meta?.toolLoop?.recent)
    ? state.meta.toolLoop.recent.slice(-20)
    : [];
  let lastProgressIndex = -1;
  recent.forEach((entry, index) => {
    if (
      RECOVERABLE_TOOL_NAMES.has(String(entry?.toolName || "")) &&
      entry?.ok === true &&
      entry?.blocked !== true
    ) {
      lastProgressIndex = index;
    }
  });
  return recent.slice(lastProgressIndex + 1).filter((entry) =>
    RECOVERABLE_TOOL_NAMES.has(String(entry?.toolName || "")) &&
    entry?.ok === false &&
    entry?.blocked !== true
  );
}

function recoveryFailureSignature(entry = {}) {
  if (
    ["patch-context-scope-mismatch", "patch-context-scope-exhausted"].includes(
      String(entry?.category || "")
    )
  ) {
    return [
      "apply_patch",
      "patch-context-scope-mismatch",
      String(entry?.path || "unknown"),
      Math.max(0, Number(entry?.goalRevision || 0)),
      Math.max(0, Number(entry?.mutationRevision || 0)),
    ].join(":");
  }
  return String(entry?.signature || `${entry?.toolName || "unknown"}:unknown`);
}

function contractViolationCount(state = {}) {
  const violation = state.meta?.toolContractViolation;
  return Math.max(0, Number(violation?.consecutive ?? violation?.count ?? 0));
}

function authenticatedAvailableModels(config = {}) {
  return Array.isArray(config.localAvailableModels)
    ? config.localAvailableModels.map((model) => safeModel(model)).filter(Boolean)
    : [];
}

function configuredRecoveryModels(config = {}, { preferCode = false } = {}) {
  const standardCandidates = [];
  if (normalizeProviderId(config.mainProvider, "") === "localllm") {
    standardCandidates.push(config.mainModel);
  }
  if (normalizeProviderId(config.spareProvider, "") === "localllm") {
    standardCandidates.push(config.spareModel);
  }
  standardCandidates.push(config.localCodeFallbackModel, LOCALLLM_MODEL_TIERS.deep.model);

  const availableModels = authenticatedAvailableModels(config);
  const codeModel = safeModel(config.localCodeModel || LOCALLLM_MODEL_TIERS.code.model);
  const verifiedCodeModel = availableModels.includes(codeModel) ? codeModel : "";
  const candidates = preferCode
    ? [verifiedCodeModel, ...standardCandidates]
    : [...standardCandidates, verifiedCodeModel];
  return [...new Set(candidates.map((model) => safeModel(model)).filter(Boolean))];
}

function selectRecoveryModel(config = {}, currentModel = "", options = {}) {
  const excludedModels = new Set(
    Array.isArray(options.excludedModels)
      ? options.excludedModels.map((model) => safeModel(model)).filter(Boolean)
      : []
  );
  for (const candidate of configuredRecoveryModels(config, options)) {
    if (candidate === currentModel || excludedModels.has(candidate)) continue;
    const tier = localLLMModelTier(candidate)?.id || "";
    if (STRONG_LOCAL_TIERS.has(tier)) return candidate;
  }
  return "";
}

function currentGoalKey(state = {}) {
  return String(
    state.meta?.goalContract?.currentHash ||
      state.meta?.goalContract?.activeHash ||
      ""
  ).trim();
}

export function decideLocalFailureRecovery(config = {}, state = {}) {
  const existing = state.meta?.localFailureRecovery;
  const currentModel = safeModel(config.model);
  const invalidContractCalls = contractViolationCount(state);
  const goalKey = currentGoalKey(state);
  const existingModel = safeModel(existing?.model);
  const existingGoalKey = String(existing?.goalKey || "").trim();
  const sameRecoveryGoal = Boolean(
    goalKey && existingGoalKey && goalKey === existingGoalKey
  );
  const currentRecoveryFailed = Boolean(
    existing?.active === true &&
      existingModel &&
      currentModel === existingModel &&
      invalidContractCalls >= 2
  );
  if (existing?.active === true && existingModel && !currentRecoveryFailed) {
    return {
      active: true,
      activated: false,
      model: existingModel,
      fromModel: safeModel(existing.fromModel || config.model),
      reason: String(existing.reason || "Persisted local failure recovery route."),
      failureCount: Number(existing.failureCount || 0),
      repeatedSignatureCount: Number(existing.repeatedSignatureCount || 0),
      contractViolationCount: Number(existing.contractViolationCount || 0),
      failedTools: Array.isArray(existing.failedTools) ? existing.failedTools : [],
      goalKey: existingGoalKey,
      attemptedModels: Array.isArray(existing.attemptedModels)
        ? existing.attemptedModels.map((model) => safeModel(model)).filter(Boolean)
        : [],
      hopCount: Math.max(0, Number(existing.hopCount || 0)),
    };
  }

  if (config.localFailureRecovery === false) return { active: false, reason: "disabled" };
  if (normalizeProviderId(config.provider, "") !== "localllm") {
    return { active: false, reason: "non-local-provider" };
  }

  const currentTier = localLLMModelTier(currentModel)?.id || "";
  const routingMode = String(config.routingMode || "").trim().toLowerCase();
  const failures = recoverableFailureWindow(state);
  const signatureCounts = new Map();
  for (const entry of failures) {
    const signature = recoveryFailureSignature(entry);
    signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
  }
  const repeatedSignatureCount = Math.max(0, ...signatureCounts.values());
  const semanticScopeMismatchCount = failures.filter((entry) =>
    ["patch-context-scope-mismatch", "patch-context-scope-exhausted"].includes(
      String(entry?.category || "")
    )
  ).length;
  const manualContractRecovery =
    routingMode === "manual" &&
    invalidContractCalls >= 2 &&
    (currentTier === "deep" || currentTier === "code");
  const manualSemanticRecovery =
    routingMode === "manual" &&
    semanticScopeMismatchCount >= 2 &&
    (currentTier === "deep" || currentTier === "code");
  if (routingMode !== "smart" && !manualContractRecovery && !manualSemanticRecovery) {
    return { active: false, reason: "non-smart-routing" };
  }

  const routeModel = safeModel(config.routeModel);
  if (
    currentTier !== "fast" &&
    (!routeModel || currentModel !== routeModel) &&
    invalidContractCalls < 2 &&
    semanticScopeMismatchCount < 2
  ) {
    return { active: false, reason: "already-strong-route" };
  }
  if (repeatedSignatureCount < 2 && failures.length < 3 && invalidContractCalls < 2) {
    return {
      active: false,
      reason: "insufficient-failure-evidence",
      failureCount: failures.length,
      repeatedSignatureCount,
      contractViolationCount: invalidContractCalls,
    };
  }

  const priorAttemptedModels = sameRecoveryGoal
    ? [
        ...(Array.isArray(existing?.attemptedModels) ? existing.attemptedModels : []),
        existing?.fromModel,
        existingModel,
      ]
    : [currentModel];
  const attemptedModels = [
    ...new Set(priorAttemptedModels.map((model) => safeModel(model)).filter(Boolean)),
  ];
  const model = selectRecoveryModel(config, currentModel, {
    preferCode:
      currentTier === "deep" &&
      (invalidContractCalls >= 2 || semanticScopeMismatchCount >= 2),
    excludedModels: attemptedModels,
  });
  if (!model) {
    return {
      active: false,
      reason: "no-strong-local-recovery-model",
      failureCount: failures.length,
      repeatedSignatureCount,
      semanticScopeMismatchCount,
      contractViolationCount: invalidContractCalls,
    };
  }

  return {
    active: true,
    activated: true,
    model,
    fromModel: currentModel,
    goalKey,
    attemptedModels: [...attemptedModels, model],
    hopCount: sameRecoveryGoal
      ? Math.max(0, Number(existing?.hopCount || 0)) + 1
      : 1,
    reason:
      invalidContractCalls >= 2
        ? "The current local route repeatedly returned tool calls that did not match the offered schemas."
        : semanticScopeMismatchCount >= 2
          ? "The current local route repeatedly proposed revision-scoped replacements that exceeded the exact source anchor without a successful mutation."
        : repeatedSignatureCount >= 2
        ? "The current local route repeated a failing tool call without verified progress."
        : "The current local route accumulated several tool failures without verified progress.",
    failureCount: failures.length + invalidContractCalls,
    repeatedSignatureCount,
    semanticScopeMismatchCount,
    contractViolationCount: invalidContractCalls,
    failedTools: [
      ...new Set([
        ...failures.map((entry) => String(entry?.toolName || "unknown")),
        ...(invalidContractCalls >= 2 ? ["tool_call_batch"] : []),
      ]),
    ],
  };
}

export function activateLocalFailureRecovery(config = {}, state = {}) {
  const decision = decideLocalFailureRecovery(config, state);
  if (!decision.active || !decision.activated) return decision;
  state.meta = state.meta || {};
  const activatedAt = new Date().toISOString();
  state.meta.localFailureRecovery = {
    active: true,
    model: decision.model,
    fromModel: decision.fromModel,
    reason: decision.reason,
    failureCount: decision.failureCount,
    repeatedSignatureCount: decision.repeatedSignatureCount,
    contractViolationCount: decision.contractViolationCount || 0,
    failedTools: decision.failedTools || [],
    goalKey: decision.goalKey || currentGoalKey(state),
    attemptedModels: Array.isArray(decision.attemptedModels)
      ? decision.attemptedModels
      : [decision.fromModel, decision.model].map((model) => safeModel(model)).filter(Boolean),
    hopCount: Math.max(1, Number(decision.hopCount || 1)),
    activatedAt,
  };
  const priorContractViolation = state.meta.toolContractViolation;
  if (priorContractViolation) {
    state.meta.toolContractViolation = {
      ...priorContractViolation,
      count: 0,
      consecutive: 0,
      resetAt: activatedAt,
      resetReason: "local-model-recovery",
    };
  }
  return decision;
}

export function applyLocalFailureRecovery(config = {}, state = {}) {
  const recovery = state.meta?.localFailureRecovery;
  const timeoutRecovery = state.meta?.modelTimeoutRecovery;
  const provider = normalizeProviderId(config.provider, "");
  const currentGoalRevision = Math.max(
    0,
    Number(state.meta?.goalContract?.revision || 0)
  );
  const activeGoalKey = currentGoalKey(state);
  const timeoutGoalRevision = Math.max(
    0,
    Number(timeoutRecovery?.goalRevision || 0)
  );
  const timeoutGoalKey = String(timeoutRecovery?.goalKey || "").trim();
  const timeoutAt = Date.parse(String(timeoutRecovery?.activatedAt || ""));
  const localRecoveryAt = Date.parse(String(recovery?.activatedAt || ""));
  const timeoutIsCurrent = Boolean(
    timeoutRecovery?.active === true &&
      normalizeProviderId(timeoutRecovery.provider, "") === provider &&
      safeModel(timeoutRecovery.model) &&
      (!timeoutGoalRevision || !currentGoalRevision || timeoutGoalRevision === currentGoalRevision) &&
      (!timeoutGoalKey || !activeGoalKey || timeoutGoalKey === activeGoalKey) &&
      Number.isFinite(timeoutAt) &&
      (!Number.isFinite(localRecoveryAt) || timeoutAt >= localRecoveryAt)
  );
  const timeoutModel = timeoutIsCurrent ? safeModel(timeoutRecovery.model) : "";
  const model = timeoutModel || (recovery?.active === true ? safeModel(recovery.model) : "");
  if (!model || normalizeProviderId(config.provider, "") !== "localllm") return config;
  if (timeoutModel) {
    return {
      ...config,
      model: timeoutModel,
      localTier: localLLMModelTier(timeoutModel)?.id || "fast",
      localSelection: "runtime-model-timeout-recovery",
      modelTimeoutRecoveryActive: true,
      routeReason: `The newer bounded timeout recovery route ${timeoutModel} supersedes the prior local tool-failure route for this goal.`,
      requiresResourcePreflight: false,
    };
  }
  return {
    ...config,
    model,
    localTier: localLLMModelTier(model)?.id || "deep",
    localSelection: "runtime-tool-failure-recovery",
    localFailureRecoveryActive: true,
    localFailureRecoveryFailedTools: Array.isArray(recovery.failedTools)
      ? recovery.failedTools
      : [],
    routeReason: String(recovery.reason || "Recovered a stalled local tool route."),
    requiresResourcePreflight: false,
  };
}

export function localFailureRecoveryInstruction(decision = {}, context = {}) {
  const requiredSymbols = (
    Array.isArray(context.requiredSymbolRepair?.contracts) &&
    context.requiredSymbolRepair.contracts.length
      ? context.requiredSymbolRepair.contracts
      : context.requiredSymbolRepair?.symbol
        ? [context.requiredSymbolRepair]
        : []
  )
    .map((contract) => String(contract?.symbol || "").trim())
    .filter((symbol, index, symbols) => symbol && symbols.indexOf(symbol) === index);
  const mutationInstruction = context.testFailureRepairMutationRequired === true
    ? [
        "The retained failed-test gate requires one coherent source mutation before verification; do not request the unchanged test command first.",
        requiredSymbols.length
          ? `Use the offered constrained patch to declare and route production code through: ${requiredSymbols.join(", ")}. Each seam must be called outside its own definition.`
          : "Use the offered constrained patch to repair the canonical source before requesting verification.",
      ].join(" ")
    : "Re-read the exact target and latest error when that tool is offered, choose one different bounded edit or command, then rerun the smallest relevant verification.";
  return [
    `Runtime recovery: the local route changed from ${decision.fromModel || "the fast model"} to ${decision.model || "the configured stronger local model"}.`,
    decision.reason || "Repeated tool failures showed no verified progress.",
    decision.contractViolationCount >= 2
      ? "The invalid calls were rejected before dispatch; use only the currently offered tool names and exact argument schemas."
      : "",
    "Continue from the current files and evidence; preserve successful work and do not restart the task.",
    `Do not repeat the failing call. ${mutationInstruction}`,
  ].filter(Boolean).join(" ");
}
