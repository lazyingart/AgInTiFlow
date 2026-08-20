#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveRuntimeConfig } from "../src/config.js";
import { permissionModeDefaults } from "../src/permission-modes.js";
import {
  SESSION_RUNTIME_CONFLICT,
  SESSION_RUNTIME_SCHEMA_VERSION,
  applySessionRuntimePatch,
  captureSessionRuntime,
  migrateLegacySessionRuntime,
  resolveSessionRuntime,
  sessionRuntimeOverrides,
} from "../src/session-runtime.js";

const SECRET = "session-runtime-smoke-secret-must-not-survive";

const localConfig = {
  provider: "localllm",
  model: "localllm-deep",
  routingMode: "smart",
  reasoning: "high",
  routeProvider: "localllm",
  routeModel: "localllm-fast",
  routeReasoning: "low",
  mainProvider: "localllm",
  mainModel: "localllm-deep",
  mainReasoning: "high",
  spareProvider: "localllm",
  spareModel: "localllm-deep",
  spareReasoning: "medium",
  preferredWrapper: "qwen",
  wrapperModel: "qwen3-coder-plus",
  wrapperReasoning: "high",
  auxiliaryProvider: "venice",
  auxiliaryModel: "qwen-image-2-pro",
  taskProfile: "code",
  language: "en",
  executionTier: "thorough",
  enableScs: "auto",
  scsValidationMode: "deterministic",
  maxSteps: 40,
  dynamicSteps: "auto",
  dynamicStepExtensionLimit: 2,
  dynamicStepHardCap: 80,
  dynamicStepExtensionSize: 8,
  headless: true,
  allowShellTool: true,
  allowFileTools: true,
  allowWrapperTools: false,
  allowAuxiliaryTools: false,
  allowWebSearch: true,
  allowMcpTools: true,
  allowParallelScouts: false,
  allowHostedImagePerception: false,
  allowHostedWebResearch: false,
  allowHostedJsonSpecialist: false,
  allowHostedWritingSpecialist: false,
  parallelScoutCount: 2,
  permissionMode: "normal",
  sandboxMode: "docker-workspace",
  packageInstallPolicy: "prompt",
  workspaceWritePolicy: "allow",
  allowPasswords: false,
  allowDestructive: false,
  allowOutsideWorkspaceFileTools: false,
  useDockerSandbox: true,
  contextBudgetMode: "auto",
  contextBudgetChars: 90_000,
  contextBudgetTargetChars: 42_000,
  contextWindowTokens: 262_144,
  maxOutputTokens: 8_192,
  contextToolReserveTokens: 6_000,
  contextBudgetTargetTokens: 120_000,
  commandCwd: "/tmp/aginti-session-runtime-smoke",
  allowedDomains: ["docs.example.test", "api.example.test"],
  readOnlyRoots: ["/tmp/reference-one", "/tmp/reference-two"],
  apiKey: SECRET,
  baseURL: `https://${SECRET}.invalid/v1`,
  onLog: () => SECRET,
  onEvent: () => SECRET,
  client: { secret: SECRET },
  signal: { reason: SECRET },
  env: { OPENAI_API_KEY: SECRET },
};

const initial = captureSessionRuntime(localConfig);
assert.equal(initial.schemaVersion, SESSION_RUNTIME_SCHEMA_VERSION);
assert.equal(initial.revision, 1);
assert.equal(initial.provider, "localllm");
assert.equal(initial.routeProvider, "localllm");
assert.equal(initial.mainProvider, "localllm");
assert.equal(initial.spareProvider, "localllm");
assert.equal(initial.routeModel, "localllm-fast");
assert.equal(initial.mainModel, "localllm-deep");
assert.equal(initial.spareModel, "localllm-deep");
assert.equal(initial.preferredWrapper, "qwen");
assert.equal(initial.wrapperModel, "qwen3-coder-plus");
assert.equal(initial.wrapperReasoning, "high");
assert.equal(initial.auxiliaryProvider, "venice");
assert.equal(initial.auxiliaryModel, "qwen-image-2-pro");
assert.equal(initial.scsValidationMode, "deterministic");
assert.equal(initial.commandCwd, localConfig.commandCwd);
assert.deepEqual(initial.allowedDomains, localConfig.allowedDomains);
assert.deepEqual(initial.readOnlyRoots, localConfig.readOnlyRoots);

const serializedInitial = JSON.stringify(initial);
assert.ok(!serializedInitial.includes(SECRET), "captured runtime leaked a credential or excluded callback value");
for (const field of ["apiKey", "baseURL", "onLog", "onEvent", "client", "signal", "env"]) {
  assert.equal(Object.prototype.hasOwnProperty.call(initial, field), false, `captured runtime included forbidden field ${field}`);
}

const savedState = {
  provider: "localllm",
  model: "localllm-deep",
  meta: { runtimeConfig: initial },
};
const resumed = resolveSessionRuntime({
  state: savedState,
  incomingConfig: {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    routeProvider: "deepseek",
    routeModel: "deepseek-v4-flash",
    mainProvider: "openai",
    mainModel: "gpt-5.5",
    preferredWrapper: "codex",
    wrapperModel: "gpt-5.5",
    auxiliaryProvider: "grsai",
    auxiliaryModel: "nano-banana-2",
    allowHostedImagePerception: true,
    allowHostedWebResearch: true,
    allowHostedJsonSpecialist: true,
    allowHostedWritingSpecialist: true,
    apiKey: SECRET,
    baseURL: "https://api.example.invalid/v1",
  },
});
assert.equal(resumed.source, "snapshot");
assert.equal(resumed.snapshot.provider, "localllm", "incoming/global provider preference replaced the saved provider");
assert.equal(resumed.runtimeOverrides.model, "localllm-deep", "incoming/global model preference replaced the saved model");
assert.equal(resumed.runtimeOverrides.routeProvider, "localllm", "saved local route role was not preserved");
assert.equal(resumed.runtimeOverrides.mainProvider, "localllm", "saved local main role was not preserved");
assert.equal(resumed.runtimeOverrides.spareProvider, "localllm", "saved local spare role was not preserved");
assert.equal(resumed.runtimeOverrides.preferredWrapper, "qwen", "saved wrapper choice was not preserved");
assert.equal(resumed.runtimeOverrides.wrapperModel, "qwen3-coder-plus", "saved wrapper model was not preserved");
assert.equal(resumed.runtimeOverrides.auxiliaryProvider, "venice", "saved auxiliary provider was not preserved");
assert.equal(resumed.runtimeOverrides.auxiliaryModel, "qwen-image-2-pro", "saved auxiliary model was not preserved");
assert.equal(resumed.runtimeOverrides.allowHostedImagePerception, false, "hosted image permission drifted on resume");
assert.equal(resumed.runtimeOverrides.allowHostedWebResearch, false, "hosted research permission drifted on resume");
assert.equal(resumed.runtimeOverrides.allowHostedJsonSpecialist, false, "hosted JSON permission drifted on resume");
assert.equal(resumed.runtimeOverrides.allowHostedWritingSpecialist, false, "hosted writer permission drifted on resume");
assert.equal(resumed.runtimeOverrides.scsValidationMode, "deterministic", "saved SCS validation policy drifted on resume");
assert.deepEqual(resumed.runtimeOverrides.allowedDomains, localConfig.allowedDomains, "saved network scope was not preserved");
assert.deepEqual(resumed.runtimeOverrides.readOnlyRoots, localConfig.readOnlyRoots, "saved read-only roots were not preserved");
assert.equal(resumed.credentialProvider, "localllm", "caller was not told which provider credentials to rebuild");
assert.ok(!JSON.stringify(resumed).includes(SECRET), "resume result leaked incoming credentials");

const patched = resolveSessionRuntime({
  state: savedState,
  incomingConfig: { provider: "deepseek", apiKey: SECRET },
  runtimePatch: {
    provider: "openai",
    model: "gpt-5.5",
    reasoning: "xhigh",
    preferredWrapper: "claude",
    wrapperModel: "sonnet",
    auxiliaryProvider: "grsai",
    auxiliaryModel: "gpt-image-2",
  },
  expectedRevision: 1,
});
assert.equal(patched.snapshot.revision, 2, "one accepted CAS patch should increment the revision exactly once");
assert.equal(patched.snapshot.provider, "openai");
assert.equal(patched.snapshot.model, "gpt-5.5");
assert.equal(patched.snapshot.routingMode, "manual", "an explicit provider/model choice should become manual routing");
assert.equal(patched.snapshot.routeProvider, "openai");
assert.equal(patched.snapshot.routeModel, "gpt-5.5");
assert.equal(patched.snapshot.mainProvider, "openai");
assert.equal(patched.snapshot.mainModel, "gpt-5.5");
assert.equal(patched.snapshot.spareProvider, "openai");
assert.equal(patched.snapshot.spareModel, "gpt-5.5");
assert.equal(patched.snapshot.reasoning, "xhigh");
assert.equal(patched.snapshot.preferredWrapper, "claude");
assert.equal(patched.snapshot.wrapperModel, "sonnet");
assert.equal(patched.snapshot.auxiliaryProvider, "grsai");
assert.equal(patched.snapshot.auxiliaryModel, "gpt-image-2");

const beforeStalePatch = JSON.stringify(initial);
assert.throws(
  () =>
    applySessionRuntimePatch(
      initial,
      {
        provider: "not-a-provider",
        apiKey: SECRET,
      },
      7
    ),
  (error) => {
    assert.equal(error.code, SESSION_RUNTIME_CONFLICT, "stale writes must report the stable conflict code");
    assert.equal(error.details.actualRevision, 1);
    return true;
  }
);
assert.equal(JSON.stringify(initial), beforeStalePatch, "a rejected stale patch mutated the saved snapshot");

assert.throws(
  () =>
    resolveSessionRuntime({
      state: savedState,
      incomingConfig: { provider: "openai", apiKey: SECRET },
      expectedRevision: 9,
    }),
  (error) => {
    assert.equal(error.code, SESSION_RUNTIME_CONFLICT, "an ordinary stale continuation must fail CAS without a patch");
    return true;
  }
);

assert.throws(
  () => applySessionRuntimePatch(initial, { provider: "not-a-provider" }, 1),
  (error) => {
    assert.equal(error.code, "SESSION_RUNTIME_INVALID_PROVIDER");
    return true;
  }
);
assert.throws(
  () => captureSessionRuntime({ provider: "not-a-provider", model: "anything" }),
  (error) => {
    assert.equal(error.code, "SESSION_RUNTIME_INVALID_PROVIDER");
    return true;
  }
);

const ignoredSecretPatch = applySessionRuntimePatch(
  initial,
  {
    apiKey: SECRET,
    baseURL: `https://${SECRET}.invalid/v1`,
    onLog: () => SECRET,
    env: { TOKEN: SECRET },
  },
  1
);
assert.equal(ignoredSecretPatch.revision, 2);
assert.ok(!JSON.stringify(ignoredSecretPatch).includes(SECRET), "non-whitelisted patch fields entered the snapshot");

const permissionRuntimeFields = Object.keys(permissionModeDefaults("normal"));
for (const permissionMode of ["safe", "normal", "danger"]) {
  const expectedDefaults = permissionModeDefaults(permissionMode);
  const modePatch = applySessionRuntimePatch(initial, { permissionMode }, 1);
  assert.equal(modePatch.revision, 2);
  for (const [field, expected] of Object.entries(expectedDefaults)) {
    assert.equal(
      modePatch[field],
      expected,
      `${permissionMode} runtime patch did not apply permission default ${field}`
    );
  }

  const resolvedMode = resolveRuntimeConfig(
    { goal: `Verify ${permissionMode} session permission defaults.` },
    { baseDir: process.cwd(), ...sessionRuntimeOverrides(modePatch) }
  );
  for (const field of permissionRuntimeFields) {
    assert.equal(
      resolvedMode[field],
      modePatch[field],
      `${permissionMode} session permission field ${field} drifted during config resolution`
    );
  }
}

const explicitPermissionOverrides = applySessionRuntimePatch(
  initial,
  {
    permissionMode: "danger",
    sandboxMode: "docker-readonly",
    packageInstallPolicy: "block",
    workspaceWritePolicy: "prompt",
    allowShellTool: false,
    allowFileTools: false,
    allowPasswords: false,
    allowDestructive: false,
    allowOutsideWorkspaceFileTools: false,
    // sandboxMode remains authoritative, matching resolveRuntimeConfig.
    useDockerSandbox: false,
  },
  1
);
assert.equal(explicitPermissionOverrides.permissionMode, "danger");
assert.equal(explicitPermissionOverrides.sandboxMode, "docker-readonly");
assert.equal(explicitPermissionOverrides.packageInstallPolicy, "block");
assert.equal(explicitPermissionOverrides.workspaceWritePolicy, "prompt");
assert.equal(explicitPermissionOverrides.allowShellTool, false);
assert.equal(explicitPermissionOverrides.allowFileTools, false);
assert.equal(explicitPermissionOverrides.allowPasswords, false);
assert.equal(explicitPermissionOverrides.allowDestructive, false);
assert.equal(explicitPermissionOverrides.allowOutsideWorkspaceFileTools, false);
assert.equal(explicitPermissionOverrides.useDockerSandbox, true);
const resolvedPermissionOverrides = resolveRuntimeConfig(
  { goal: "Verify explicit permission-field overrides." },
  { baseDir: process.cwd(), ...sessionRuntimeOverrides(explicitPermissionOverrides) }
);
for (const field of permissionRuntimeFields) {
  assert.equal(
    resolvedPermissionOverrides[field],
    explicitPermissionOverrides[field],
    `explicit session permission field ${field} drifted during config resolution`
  );
}

const boundedPatch = applySessionRuntimePatch(
  initial,
  {
    dynamicStepExtensionLimit: 8,
    parallelScoutCount: 10,
    contextWindowTokens: 262_144,
    maxOutputTokens: 8_192,
    contextToolReserveTokens: 16_384,
  },
  1
);
const boundedResolved = resolveRuntimeConfig(
  { goal: "Verify session runtime bounds." },
  { baseDir: process.cwd(), ...sessionRuntimeOverrides(boundedPatch) }
);
for (const field of [
  "dynamicStepExtensionLimit",
  "parallelScoutCount",
  "contextWindowTokens",
  "maxOutputTokens",
  "contextToolReserveTokens",
]) {
  assert.equal(boundedResolved[field], boundedPatch[field], `session runtime field ${field} drifted during config resolution`);
}
assert.throws(
  () => applySessionRuntimePatch(initial, { maxOutputTokens: 8_193 }, 1),
  (error) => error.code === "SESSION_RUNTIME_INVALID_FIELD"
);

const legacy = migrateLegacySessionRuntime({
  provider: "localllm",
  model: "localllm-deep",
  routingMode: "smart",
  routeProvider: "deepseek",
  mainProvider: "openai",
  modelRoles: {
    route: { provider: "deepseek", model: "deepseek-v4-flash" },
    main: { provider: "openai", model: "gpt-5.5" },
  },
  commandCwd: "/tmp/legacy-local-session",
});
assert.equal(legacy.routingMode, "manual");
assert.equal(legacy.provider, "localllm");
assert.equal(legacy.routeProvider, "localllm", "legacy migration introduced a hosted route role");
assert.equal(legacy.mainProvider, "localllm", "legacy migration introduced a hosted main role");
assert.equal(legacy.spareProvider, "localllm", "legacy migration introduced a hosted spare role");
assert.equal(legacy.routeModel, "localllm-deep");
assert.equal(legacy.mainModel, "localllm-deep");
assert.equal(legacy.spareModel, "localllm-deep");

const legacyResume = resolveSessionRuntime({
  state: {
    provider: "localllm",
    model: "localllm-fast",
    modelRoles: {
      route: { provider: "deepseek" },
      main: { provider: "openai" },
    },
  },
  incomingConfig: {
    provider: "openai",
    model: "gpt-5.5",
    routeProvider: "openai",
    mainProvider: "openai",
  },
});
assert.equal(legacyResume.source, "legacy");
assert.equal(legacyResume.runtimeOverrides.provider, "localllm");
assert.equal(legacyResume.runtimeOverrides.routeProvider, "localllm");
assert.equal(legacyResume.runtimeOverrides.mainProvider, "localllm");
assert.equal(legacyResume.runtimeOverrides.spareProvider, "localllm");

const overrides = sessionRuntimeOverrides(initial);
assert.equal(overrides.schemaVersion, undefined);
assert.equal(overrides.revision, undefined);
assert.equal(overrides.provider, "localllm");
assert.ok(!JSON.stringify(overrides).includes(SECRET));

console.log("smoke-session-runtime ok");
