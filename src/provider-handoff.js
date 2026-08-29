import { LOCALLLM_MODEL_TIERS } from "./model-routing.js";
import { normalizeProviderId } from "./provider-contract.js";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function enabled(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return !/^(?:0|false|off|no)$/i.test(String(value).trim());
}

function providerErrorText(error) {
  return [
    error?.code,
    error?.type,
    error?.message,
    error?.error?.code,
    error?.error?.type,
    error?.error?.message,
    error?.response?.data?.error?.code,
    error?.response?.data?.error?.type,
    error?.response?.data?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function classifyProviderHandoffError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || "").trim().toUpperCase();
  const name = String(error?.name || "").trim();
  const text = providerErrorText(error);

  if (
    ["TOOL_CONTRACT_VIOLATION", "MALFORMED_TOOL_ARGUMENTS"].includes(code)
  ) {
    return { eligible: true, code: "provider_tool_contract", status };
  }

  if (
    status === 402 ||
    /insufficient[_ -]?(?:quota|balance)|quota exceeded|billing|account balance|credits? exhausted/.test(text)
  ) {
    return { eligible: true, code: "provider_quota", status };
  }
  if (
    code === "API_KEY_REQUIRED" ||
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|invalid[_ -]?api[_ -]?key|permission denied/.test(text)
  ) {
    return { eligible: true, code: "provider_auth", status };
  }
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(text)) {
    return { eligible: true, code: "provider_rate_limited", status };
  }
  if (
    name === "ModelTimeoutError" ||
    code === "MODEL_TIMEOUT" ||
    /(?:agent step|model) request timed out after \d+ms/.test(text)
  ) {
    return { eligible: true, code: "provider_timeout", status };
  }
  if (
    status === 404 &&
    /model|deployment|endpoint|not found|does not exist|unavailable/.test(text)
  ) {
    return { eligible: true, code: "provider_model_unavailable", status };
  }
  if (
    status === 408 ||
    status === 503 ||
    status === 529 ||
    status >= 500 ||
    NETWORK_ERROR_CODES.has(code) ||
    /overload|overloaded|capacity|temporarily unavailable|connection refused|network unreachable/.test(text)
  ) {
    return { eligible: true, code: "provider_unavailable", status };
  }
  return { eligible: false, code: "provider_request_failed", status };
}

export function resolveProviderHandoff(error, config = {}, { stage = "runtime" } = {}) {
  const sourceProvider = normalizeProviderId(config.provider, "");
  const targetProvider = normalizeProviderId(
    config.providerHandoffProvider || process.env.AGINTI_PROVIDER_HANDOFF_PROVIDER || "localllm",
    ""
  );
  if (!enabled(config.allowProviderHandoff ?? process.env.AGINTI_PROVIDER_HANDOFF, true)) return null;
  if (!sourceProvider || sourceProvider === "mock" || sourceProvider === "localllm") return null;
  if (!targetProvider || targetProvider !== "localllm" || targetProvider === sourceProvider) return null;
  if (String(config.routingMode || "smart").trim().toLowerCase() === "manual") return null;
  if (String(config.integrationSessionProfile || "").trim()) return null;
  if (stage !== "preflight" && error?.agintiProviderRequest !== true) return null;

  const failure = classifyProviderHandoffError(error);
  if (!failure.eligible) return null;

  const routeModel =
    String(config.providerHandoffRouteModel || process.env.AGINTI_LOCALLLM_ROUTE_MODEL || "").trim() ||
    LOCALLLM_MODEL_TIERS.fast.model;
  const mainModel =
    String(
      config.providerHandoffModel ||
        process.env.AGINTI_PROVIDER_HANDOFF_MODEL ||
        process.env.AGINTI_LOCALLLM_MAIN_MODEL ||
        ""
    ).trim() || LOCALLLM_MODEL_TIERS.deep.model;

  return {
    version: 1,
    sourceProvider,
    sourceModel: String(config.model || ""),
    targetProvider,
    targetModel: mainModel,
    routeModel,
    mainModel,
    spareModel: mainModel,
    failureCode: failure.code,
    status: failure.status,
    runtimePatch: {
      provider: targetProvider,
      model: mainModel,
      routingMode: "manual",
      routeProvider: targetProvider,
      routeModel,
      mainProvider: targetProvider,
      mainModel,
      spareProvider: targetProvider,
      spareModel: mainModel,
    },
  };
}
