const responseContracts = new WeakMap();
const contractMarker = Symbol("aginti.tool-contract");
const trustedMockDryRunMarker = Symbol("aginti.tool-contract.trusted-mock-dry-run");
const TRUSTED_MOCK_DRY_RUN_TOOLS = new Set(["generate_image", "read_image"]);

const SAFE_SEQUENTIAL_READ_TOOLS = new Set([
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "read_image",
  "web_search",
  "read_web_page",
  "web_research",
  "long_job_status",
  "tmux_list_sessions",
  "tmux_capture_pane",
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
  "agentlink_status",
  "agentlink_list_peers",
  "agentlink_get_board",
]);

const MAX_VALIDATION_ERRORS = 8;
const MAX_VALIDATION_NODES = 50_000;
const MAX_SAFE_SEQUENTIAL_READ_CALLS = 4;
const MAX_REPORTED_SEQUENTIAL_CALLS = 12;
const BENIGN_TOOL_CALL_ANNOTATION_KEYS = new Set(["description", "reason"]);

function cloneValue(value) {
  return structuredClone(value);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaTypeMatches(value, expectedType) {
  switch (expectedType) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function addSchemaError(context, code, path, message) {
  context.invalid = true;
  if (context.errors.length >= MAX_VALIDATION_ERRORS) return;
  context.errors.push({ code, path, message });
}

function schemaFieldRequirement(schema) {
  if (typeof schema?.description !== "string") return "";
  const description = schema.description.replace(/\s+/g, " ").trim();
  return description ? description.slice(0, 320) : "";
}

function validateSchemaValue(value, schema, path, context, depth = 0) {
  context.nodes += 1;
  if (context.nodes > MAX_VALIDATION_NODES || depth > 32) {
    addSchemaError(context, "SCHEMA_VALIDATION_LIMIT", path, "exceeded the bounded schema-validation limit");
    return;
  }
  if (!isPlainObject(schema)) {
    addSchemaError(context, "TOOL_SCHEMA_INVALID", path, "has no valid JSON schema");
    return;
  }

  if (Object.hasOwn(schema, "const") && !sameJsonValue(value, schema.const)) {
    addSchemaError(context, "ARGUMENT_CONST_MISMATCH", path, "does not match the required constant");
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJsonValue(value, candidate))) {
    addSchemaError(context, "ARGUMENT_ENUM_MISMATCH", path, "is not one of the allowed values");
  }

  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expectedTypes.length > 0 && !expectedTypes.some((expectedType) => schemaTypeMatches(value, expectedType))) {
    addSchemaError(context, "ARGUMENT_WRONG_TYPE", path, `must be ${expectedTypes.join(" or ")}`);
    return;
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      addSchemaError(context, "ARGUMENT_STRING_TOO_SHORT", path, `must contain at least ${schema.minLength} characters`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      addSchemaError(context, "ARGUMENT_STRING_TOO_LONG", path, `must contain at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          const requirement = schemaFieldRequirement(schema);
          addSchemaError(
            context,
            "ARGUMENT_PATTERN_MISMATCH",
            path,
            `does not match the required pattern${requirement ? `; field requirement: ${requirement}` : ""}`
          );
        }
      } catch {
        addSchemaError(context, "TOOL_SCHEMA_INVALID", path, "uses an invalid pattern");
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      addSchemaError(context, "ARGUMENT_NUMBER_TOO_SMALL", path, `must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      addSchemaError(context, "ARGUMENT_NUMBER_TOO_LARGE", path, `must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      addSchemaError(context, "ARGUMENT_ARRAY_TOO_SHORT", path, `must contain at least ${schema.minItems} items`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      addSchemaError(context, "ARGUMENT_ARRAY_TOO_LONG", path, `must contain at most ${schema.maxItems} items`);
    }
    if (isPlainObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        validateSchemaValue(value[index], schema.items, `${path}[${index}]`, context, depth + 1);
        if (context.nodes > MAX_VALIDATION_NODES) break;
      }
    }
  }

  if (!isPlainObject(value)) return;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const property of required) {
    if (typeof property === "string" && !Object.hasOwn(value, property)) {
      addSchemaError(context, "ARGUMENT_REQUIRED_PROPERTY_MISSING", `${path}.${property}`, "is required");
    }
  }
  for (const [property, childValue] of Object.entries(value)) {
    if (Object.hasOwn(properties, property)) {
      validateSchemaValue(childValue, properties[property], `${path}.${property}`, context, depth + 1);
      continue;
    }
    if (schema.additionalProperties === false) {
      addSchemaError(context, "ARGUMENT_ADDITIONAL_PROPERTY", path, "contains an additional property that is not allowed");
    } else if (isPlainObject(schema.additionalProperties)) {
      validateSchemaValue(childValue, schema.additionalProperties, `${path}.*`, context, depth + 1);
    }
  }
}

function batchReason(code) {
  switch (code) {
    case "TOOL_CONTRACT_MISSING":
      return "The model response had no authenticated per-turn tool contract and was not dispatched.";
    case "TOOL_CALL_BATCH_INVALID":
      return "The model returned an invalid tool-call batch and none of the calls were dispatched.";
    case "TOO_MANY_TOOL_CALLS":
      return "The model returned more tool calls than the current safety policy permits; none were dispatched.";
    case "TOOL_CALL_ID_EMPTY":
    case "TOOL_CALL_ID_DUPLICATE":
      return "The model returned invalid tool-call identifiers and none of the calls were dispatched.";
    case "TOOL_NOT_OFFERED":
      return "The model requested a tool that was not offered for this turn and it was not dispatched.";
    case "TOOL_ARGUMENTS_INVALID_JSON":
      return "The model returned tool arguments that were not valid JSON and they were not dispatched.";
    case "TOOL_ARGUMENTS_SCHEMA_INVALID":
      return "The model returned tool arguments that did not match the offered schema and they were not dispatched.";
    default:
      return "The model returned an invalid tool call and it was not dispatched.";
  }
}

export function createToolContract(tools = [], { trustedMockDryRun = false } = {}) {
  if (!Array.isArray(tools)) throw new TypeError("Tool contract descriptors must be an array.");
  const descriptors = deepFreeze(cloneValue(tools));
  const names = new Set();
  for (const descriptor of descriptors) {
    const name = descriptor?.type === "function" ? descriptor.function?.name : "";
    if (!name || names.has(name)) throw new TypeError("Tool contract descriptors require unique function names.");
    names.add(name);
  }
  const contract = { tools: descriptors };
  Object.defineProperty(contract, contractMarker, { value: true });
  Object.defineProperty(contract, trustedMockDryRunMarker, { value: trustedMockDryRun === true });
  return Object.freeze(contract);
}

export function attachToolContract(response, tools = [], options = {}) {
  if (!response || typeof response !== "object") return response;
  responseContracts.set(response, createToolContract(tools, options));
  return response;
}

export function toolContractFromResponse(response) {
  if (!response || typeof response !== "object") return null;
  return responseContracts.get(response) || null;
}

export function safeSequentialToolBatchLimit(toolCalls) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (calls.length <= 1) return 1;
  const names = calls.map((call) => (
    call?.type === "function" && typeof call?.function?.name === "string"
      ? call.function.name
      : ""
  ));
  return names.length === calls.length && names.every((name) => SAFE_SEQUENTIAL_READ_TOOLS.has(name))
    ? MAX_SAFE_SEQUENTIAL_READ_CALLS
    : 1;
}

function isSafeSequentialReadBatch(toolCalls) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  return (
    calls.length > 0 &&
    calls.every(
      (call) =>
        call?.type === "function" &&
        typeof call?.function?.name === "string" &&
        SAFE_SEQUENTIAL_READ_TOOLS.has(call.function.name)
    )
  );
}

function recoverSingletonEnumReadCall(toolCalls, contract, validation) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  if (calls.length !== 1 || !errors.length || contract?.[contractMarker] !== true) return null;
  const call = calls[0];
  const toolName = String(call?.function?.name || "");
  if (!SAFE_SEQUENTIAL_READ_TOOLS.has(toolName) || typeof call?.function?.arguments !== "string") return null;
  const specificErrors = errors.filter((error) => error?.code !== "TOOL_ARGUMENTS_SCHEMA_INVALID");
  if (!specificErrors.length || specificErrors.some((error) => error?.code !== "ARGUMENT_ENUM_MISMATCH")) return null;

  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return null;
  }
  if (!isPlainObject(args)) return null;
  const descriptor = contract.tools.find(
    (candidate) => candidate?.type === "function" && candidate.function?.name === toolName
  );
  const properties = descriptor?.function?.parameters?.properties;
  if (!isPlainObject(properties)) return null;

  const correctedArgs = { ...args };
  const corrections = [];
  for (const error of specificErrors) {
    const match = /^\$\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(error?.path || ""));
    if (!match) return null;
    const property = match[1];
    const choices = properties[property]?.enum;
    if (!Array.isArray(choices) || choices.length !== 1) return null;
    correctedArgs[property] = cloneValue(choices[0]);
    corrections.push({ property, source: "singleton-enum" });
  }
  if (!corrections.length) return null;

  const correctedCall = {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify(correctedArgs),
    },
  };
  const correctedValidation = validateToolCallBatch([correctedCall], contract, { maxToolCalls: 1 });
  if (!correctedValidation.ok) return null;
  return {
    ...correctedValidation,
    acceptedToolCalls: [correctedCall],
    deferredToolCalls: [],
    recoveredSequentially: false,
    recoveredSingletonEnums: true,
    argumentCorrections: corrections,
    originalCode: validation.code,
  };
}

function recoverReadFileRangeAlias(toolCalls, contract, validation) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  if (calls.length !== 1 || !errors.length || contract?.[contractMarker] !== true) return null;
  const call = calls[0];
  if (
    String(call?.function?.name || "") !== "read_file" ||
    typeof call?.function?.arguments !== "string"
  ) {
    return null;
  }
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return null;
  }
  if (
    !isPlainObject(args) ||
    typeof args.range !== "string" ||
    Object.hasOwn(args, "startLine") ||
    Object.hasOwn(args, "lineLimit")
  ) {
    return null;
  }
  const specificErrors = errors.filter(
    (error) => error?.code !== "TOOL_ARGUMENTS_SCHEMA_INVALID"
  );
  if (
    specificErrors.length !== 1 ||
    specificErrors[0]?.code !== "ARGUMENT_ADDITIONAL_PROPERTY"
  ) {
    return null;
  }
  const normalizedRange = args.range.trim();
  const bounded = /^(?:from\s+)?lines?\s+(\d+)\s*(?:-|to|through)\s*(?:line\s+)?(\d+)$/i.exec(
    normalizedRange
  ) || /^(\d+)\s*[-:]\s*(\d+)$/.exec(normalizedRange);
  const openEnded = /^(?:from\s+)?line\s+(\d+)$/i.exec(normalizedRange);
  if (!bounded && !openEnded) return null;
  const startLine = Number(bounded?.[1] || openEnded?.[1] || 0);
  const endLine = Number(bounded?.[2] || 0);
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    (bounded && (!Number.isInteger(endLine) || endLine < startLine))
  ) {
    return null;
  }
  const correctedArgs = { ...args, startLine };
  delete correctedArgs.range;
  if (bounded) correctedArgs.lineLimit = endLine - startLine + 1;
  const correctedCall = {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify(correctedArgs),
    },
  };
  const correctedValidation = validateToolCallBatch([correctedCall], contract, {
    maxToolCalls: 1,
  });
  if (!correctedValidation.ok) return null;
  return {
    ...correctedValidation,
    acceptedToolCalls: [correctedCall],
    deferredToolCalls: [],
    recoveredSequentially: false,
    recoveredReadRangeAlias: true,
    argumentCorrections: [{ property: "range", source: "read-file-line-range" }],
    originalCode: validation.code,
  };
}

function recoverBoundedCommitSubject(toolCalls, contract, validation) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  if (calls.length !== 1 || !errors.length || contract?.[contractMarker] !== true) return null;
  const call = calls[0];
  if (
    String(call?.function?.name || "") !== "commit_project_changes" ||
    typeof call?.function?.arguments !== "string"
  ) {
    return null;
  }
  const specificErrors = errors.filter(
    (error) => error?.code !== "TOOL_ARGUMENTS_SCHEMA_INVALID"
  );
  if (
    specificErrors.length !== 1 ||
    specificErrors[0]?.code !== "ARGUMENT_STRING_TOO_LONG" ||
    specificErrors[0]?.path !== "$.message"
  ) {
    return null;
  }

  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return null;
  }
  if (!isPlainObject(args) || typeof args.message !== "string") return null;
  const descriptor = contract.tools.find(
    (candidate) =>
      candidate?.type === "function" &&
      candidate.function?.name === "commit_project_changes"
  );
  const messageSchema = descriptor?.function?.parameters?.properties?.message;
  const maximum = Number(messageSchema?.maxLength || 0);
  const minimum = Math.max(1, Number(messageSchema?.minLength || 1));
  if (!Number.isInteger(maximum) || maximum < minimum) return null;

  const normalized = args.message.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum || normalized.length < minimum) return null;
  let bounded = normalized.slice(0, maximum).trimEnd();
  const lastSpace = bounded.lastIndexOf(" ");
  if (lastSpace >= Math.max(minimum, Math.floor(maximum * 0.7))) {
    bounded = bounded.slice(0, lastSpace).trimEnd();
  }
  bounded = bounded.replace(/[,:;\-]+$/g, "").trimEnd();
  if (bounded.length < minimum) return null;

  const correctedCall = {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify({ ...args, message: bounded }),
    },
  };
  const correctedValidation = validateToolCallBatch([correctedCall], contract, {
    maxToolCalls: 1,
  });
  if (!correctedValidation.ok) return null;
  return {
    ...correctedValidation,
    acceptedToolCalls: [correctedCall],
    deferredToolCalls: [],
    recoveredSequentially: false,
    recoveredBoundedCommitSubject: true,
    argumentCorrections: [{ property: "message", source: "bounded-commit-subject" }],
    originalCode: validation.code,
  };
}

function normalizeBenignToolCallAnnotations(toolCalls, contract) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (!calls.length || contract?.[contractMarker] !== true) return null;

  const normalizedCalls = [];
  const corrections = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const toolName = String(call?.function?.name || "");
    const descriptor = contract.tools.find(
      (candidate) =>
        candidate?.type === "function" && candidate.function?.name === toolName
    );
    if (!descriptor || typeof call?.function?.arguments !== "string") return null;

    let args;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return null;
    }
    if (!isPlainObject(args)) return null;

    const parameters = descriptor.function?.parameters;
    const properties = isPlainObject(parameters?.properties)
      ? parameters.properties
      : {};
    const correctedArgs = { ...args };
    const removed = [];
    for (const key of BENIGN_TOOL_CALL_ANNOTATION_KEYS) {
      if (
        parameters?.additionalProperties === false &&
        !Object.hasOwn(properties, key) &&
        Object.hasOwn(correctedArgs, key) &&
        typeof correctedArgs[key] === "string" &&
        correctedArgs[key].length <= 1_000
      ) {
        delete correctedArgs[key];
        removed.push(key);
        corrections.push({
          callIndex: index,
          property: key,
          source: "non-executable-tool-annotation",
        });
      }
    }

    normalizedCalls.push(
      removed.length
        ? {
            ...call,
            function: {
              ...call.function,
              arguments: JSON.stringify(correctedArgs),
            },
          }
        : call
    );
  }

  return corrections.length ? { calls: normalizedCalls, corrections } : null;
}

export function validateToolCallBatch(toolCalls, contract, { maxToolCalls = 1 } = {}) {
  const errors = [];
  const addError = (code, callIndex, message) => {
    if (errors.length < MAX_VALIDATION_ERRORS) errors.push({ code, callIndex, message });
  };

  if (!contract || contract[contractMarker] !== true || !Array.isArray(contract.tools)) {
    addError("TOOL_CONTRACT_MISSING", -1, "No trusted per-turn tool contract was attached to the model response.");
  }
  if (!Array.isArray(toolCalls)) {
    addError("TOOL_CALL_BATCH_INVALID", -1, "tool_calls must be an array.");
  }

  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const boundedMaxToolCalls = Math.max(1, Number(maxToolCalls) || 1);
  if (calls.length > boundedMaxToolCalls) {
    addError(
      "TOO_MANY_TOOL_CALLS",
      -1,
      `At most ${boundedMaxToolCalls} tool call${boundedMaxToolCalls === 1 ? " is" : "s are"} permitted per model turn.`
    );
  }

  const ids = new Set();
  const parsedCalls = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const id = typeof call?.id === "string" ? call.id.trim() : "";
    if (!id) {
      addError("TOOL_CALL_ID_EMPTY", index, "Tool call id must be a nonempty string.");
    } else if (ids.has(id)) {
      addError("TOOL_CALL_ID_DUPLICATE", index, "Tool call ids must be unique within a turn.");
    } else {
      ids.add(id);
    }
    if (call?.type !== "function" || !isPlainObject(call?.function)) {
      addError("TOOL_CALL_INVALID", index, "Tool call must use the function call shape.");
      continue;
    }

    const name = typeof call.function.name === "string" ? call.function.name : "";
    const descriptor = contract?.[contractMarker] === true
      ? contract.tools.find((candidate) => candidate?.type === "function" && candidate.function?.name === name)
      : null;
    if (!name || !descriptor) {
      addError("TOOL_NOT_OFFERED", index, "Tool name must exactly match a tool offered for this turn.");
      continue;
    }

    if (typeof call.function.arguments !== "string") {
      addError("TOOL_ARGUMENTS_INVALID_JSON", index, "Tool arguments must be a JSON string.");
      continue;
    }
    let args;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      addError("TOOL_ARGUMENTS_INVALID_JSON", index, "Tool arguments must contain valid JSON.");
      continue;
    }

    let schemaArgs = args;
    if (
      contract?.[trustedMockDryRunMarker] === true &&
      TRUSTED_MOCK_DRY_RUN_TOOLS.has(name) &&
      isPlainObject(args) &&
      Object.hasOwn(args, "dryRun")
    ) {
      if (args.dryRun !== true) {
        addError("TRUSTED_MOCK_ARGUMENT_INVALID", index, "The trusted mock dry-run marker must be true.");
        continue;
      }
      schemaArgs = { ...args };
      delete schemaArgs.dryRun;
    }

    const schemaContext = { errors: [], invalid: false, nodes: 0 };
    validateSchemaValue(schemaArgs, descriptor.function?.parameters, "$", schemaContext);
    if (schemaContext.invalid) {
      addError("TOOL_ARGUMENTS_SCHEMA_INVALID", index, "Tool arguments did not match the offered schema.");
      for (const schemaError of schemaContext.errors) {
        if (errors.length >= MAX_VALIDATION_ERRORS) break;
        errors.push({ ...schemaError, callIndex: index });
      }
      continue;
    }

    const properties = descriptor.function?.parameters?.properties;
    const standardApplyPatchContract =
      name === "apply_patch" &&
      isPlainObject(properties) &&
      ["patch", "path", "search", "replace"].every((property) =>
        Object.hasOwn(properties, property)
      );
    if (standardApplyPatchContract) {
      const hasPatchDocument =
        typeof args.patch === "string" && args.patch.trim().length > 0;
      const hasExactPatch =
        typeof args.path === "string" &&
        args.path.trim().length > 0 &&
        typeof args.search === "string" &&
        args.search.length > 0 &&
        typeof args.replace === "string";
      if (!hasPatchDocument && !hasExactPatch) {
        addError(
          "TOOL_ARGUMENTS_SCHEMA_INVALID",
          index,
          "apply_patch requires either a nonempty patch document or path/search/replace exact-patch arguments."
        );
        for (const property of ["path", "search", "replace"]) {
          if (
            errors.length < MAX_VALIDATION_ERRORS &&
            (typeof args[property] !== "string" ||
              (property !== "replace" && args[property].length === 0))
          ) {
            errors.push({
              code: "ARGUMENT_REQUIRED_PROPERTY_MISSING",
              callIndex: index,
              path: `$.${property}`,
              message: `is required for exact apply_patch mode when patch is absent`,
            });
          }
        }
        continue;
      }
    }
    parsedCalls.push({ id, name, args, descriptor });
  }

  if (errors.length > 0) {
    const code = errors[0].code;
    return {
      ok: false,
      category: "tool-contract-violation",
      code,
      reason: batchReason(code),
      errors,
    };
  }
  return { ok: true, calls: parsedCalls };
}

export function resolveDispatchableToolCallBatch(toolCalls, contract) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const validation = validateToolCallBatch(calls, contract, {
    maxToolCalls: safeSequentialToolBatchLimit(calls),
  });
  if (validation.ok) {
    return {
      ...validation,
      acceptedToolCalls: calls,
      deferredToolCalls: [],
      recoveredSequentially: false,
    };
  }

  const annotationNormalization = normalizeBenignToolCallAnnotations(calls, contract);
  if (annotationNormalization) {
    const recovered = resolveDispatchableToolCallBatch(
      annotationNormalization.calls,
      contract
    );
    if (recovered.ok) {
      return {
        ...recovered,
        recoveredToolCallAnnotations: true,
        argumentCorrections: [
          ...(Array.isArray(recovered.argumentCorrections)
            ? recovered.argumentCorrections
            : []),
          ...annotationNormalization.corrections,
        ],
        originalCode: validation.code,
      };
    }
  }

  const readRangeRecovery = recoverReadFileRangeAlias(calls, contract, validation);
  if (readRangeRecovery) return readRangeRecovery;

  const commitSubjectRecovery = recoverBoundedCommitSubject(calls, contract, validation);
  if (commitSubjectRecovery) return commitSubjectRecovery;

  const singletonEnumRecovery = recoverSingletonEnumReadCall(calls, contract, validation);
  if (singletonEnumRecovery) return singletonEnumRecovery;

  const errors = Array.isArray(validation.errors) ? validation.errors : [];
  const onlyExceededBatchLimit =
    errors.length > 0 && errors.every((error) => error?.code === "TOO_MANY_TOOL_CALLS");
  const safeReadBatch = isSafeSequentialReadBatch(calls);
  // The model may report a bounded batch even though the runtime deliberately
  // dispatches only one mixed/mutating call at a time. Validate every reported
  // call against the authenticated contract, then defer the untouched suffix.
  // This keeps writes sequential without turning a harmless fifth call into a
  // whole-turn failure.
  const recoverableCallLimit = MAX_REPORTED_SEQUENTIAL_CALLS;
  if (
    !onlyExceededBatchLimit ||
    calls.length <= 1 ||
    calls.length > recoverableCallLimit
  ) {
    return validation;
  }

  const acceptedCount = safeReadBatch
    ? Math.min(MAX_SAFE_SEQUENTIAL_READ_CALLS, calls.length)
    : 1;
  const acceptedCalls = calls.slice(0, acceptedCount);
  const acceptedValidation = validateToolCallBatch(acceptedCalls, contract, {
    maxToolCalls: acceptedCount,
  });
  if (!acceptedValidation.ok) return validation;

  return {
    ...acceptedValidation,
    acceptedToolCalls: acceptedCalls,
    deferredToolCalls: calls.slice(acceptedCount),
    recoveredSequentially: true,
    originalCode: validation.code,
  };
}
