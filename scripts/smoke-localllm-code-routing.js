#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  LOCALLLM_CODE_ROUTE_OUTCOMES,
  applyLocalCodeRoute,
  captureLocalCodePolicy,
  resolveLocalCodeRoute,
  restoreLocalCodePolicy,
} from "../src/local-code-routing.js";
import { isLocalAutoMaxCandidate } from "../src/local-auto-max.js";
import { hasLocalLLMCodeIntent, selectModelRoute } from "../src/model-routing.js";

const CONFIG_ENV_PATTERN = /^(?:AGENT|AGINTI|AGINTIFLOW|LOCALLLM|LOCAL_LLM|LLM|DEEPSEEK|OPENAI|OPENROUTER|QWEN|VENICE|GRSAI|BRAVE|ALLOW_|WRAPPER_|MAX_STEPS$|SANDBOX_MODE$|USE_DOCKER_SANDBOX$|PACKAGE_INSTALL_POLICY$|COMMAND_CWD$|PREFERRED_WRAPPER$)/u;
const TEST_BEARER = "offline-code-routing-bearer";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codeGoal = "Implement the parser module, fix the regression, and add deterministic unit tests.";
const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-code-route-"));
const smokeProject = path.join(smokeRoot, "project");
await fs.mkdir(smokeProject, { recursive: true });

function readiness(models, { authenticated = true } = {}) {
  return {
    ok: true,
    checks: {
      authentication: { ok: authenticated, scheme: "bearer" },
      models: { ok: true, available: models },
    },
  };
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function withProviderFixture(callback) {
  const state = {
    codeAvailable: true,
    modelRequests: 0,
    authenticatedModelRequests: 0,
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        service: "localllm-api",
        ollama: { ok: true, version: "offline-code-routing-fixture" },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      state.modelRequests += 1;
      if (request.headers.authorization !== `Bearer ${TEST_BEARER}`) {
        writeJson(response, 401, { error: { message: "unauthorized" } });
        return;
      }
      state.authenticatedModelRequests += 1;
      const ids = ["localllm-fast", "localllm-deep"];
      if (state.codeAvailable) ids.push("localllm-code");
      writeJson(response, 200, {
        object: "list",
        data: ids.map((id) => ({ id, object: "model" })),
      });
      return;
    }
    writeJson(response, 404, { ok: false });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await callback({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      fixture: state,
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

async function integrationConfig({ root, id, baseURL, resume = false, codeModel = "localllm-code" }) {
  const workspace = path.join(root, "workspaces", id);
  await fs.mkdir(workspace, { recursive: true });
  const observed = { factoryModels: [], requestModels: [], resourceProbes: 0 };
  const config = resolveRuntimeConfig(
    {
      goal: resume ? "Continue the saved implementation and preserve its runtime." : codeGoal,
      taskProfile: "code",
      maxSteps: 1,
      ...(resume ? { resume: id } : {}),
    },
    {
      baseDir: workspace,
      packageDir: packageRoot,
      provider: "localllm",
      routingMode: "smart",
      baseURL,
      apiKey: TEST_BEARER,
      localCodeModel: codeModel,
      allowLocalAutoMax: true,
      commandCwd: workspace,
      sessionId: id,
      maxSteps: 1,
      dynamicSteps: "off",
      enableScs: "off",
      allowFileTools: false,
      allowShellTool: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      providerReadinessTimeoutMs: 500,
    }
  );
  config.localResourceProbe = async () => {
    observed.resourceProbes += 1;
    throw new Error("coding specialist routing must not enter the Max resource gate");
  };
  config.clientFactory = async (effectiveConfig) => {
    observed.factoryModels.push(effectiveConfig.model);
    return {
      chat: {
        completions: {
          create: async (request) => {
            observed.requestModels.push(request.model);
            return {
              choices: [{ message: { role: "assistant", content: "Here is the requested deterministic implementation." } }],
            };
          },
        },
      },
    };
  };
  config.onConsole = () => {};
  config.onEvent = () => {};
  config.onLog = () => {};
  return { config, observed };
}

try {
  for (const key of Object.keys(process.env)) {
    if (CONFIG_ENV_PATTERN.test(key)) delete process.env[key];
  }
  process.env.AGINTIFLOW_HOME = path.join(smokeRoot, "home");

  assert.equal(hasLocalLLMCodeIntent(codeGoal, "code"), true);
  assert.equal(hasLocalLLMCodeIntent("Explain this parser without changing it.", "code"), false);
  assert.equal(hasLocalLLMCodeIntent("Explain this code without editing anything.", "code"), false);
  assert.equal(hasLocalLLMCodeIntent("Write a chapter about refactoring code.", "writing"), false);
  assert.equal(hasLocalLLMCodeIntent("Research techniques for debugging Python applications.", "research"), false);
  for (const goal of [
    "Implement authentication",
    "Fix login",
    "Build a calculator",
    "Add dark mode",
    "Refactor auth",
    "Update dependencies",
    "Upgrade React",
    "Fix a race condition",
    "Please investigate and fix login",
    "Resolve a TypeScript compilation error",
    "Implement OAuth",
    "Implement user registration",
    "Implement payment processing",
    "Build a todo list",
    "Add a settings page",
    "Create a game",
    "Fix the crash",
    "Please review the failure and fix it",
    "Continue implementing the feature",
    "帮我写一个登录页面",
    "Please code a calculator.",
    "Can you make a login page?",
    "Set up authentication.",
    "Integrate OAuth.",
    "Complete the implementation.",
    "Finish this feature.",
    "Implement rate limiting",
    "Add pagination",
    "Fix a memory leak",
    "Upgrade Node",
    "Repair CI",
    "Wire up OAuth",
    "Make the button work",
  ]) {
    assert.equal(hasLocalLLMCodeIntent(goal, "auto"), true, goal);
  }
  for (const goal of [
    "Explain how to implement this API",
    "Compare ways to implement this API",
    "Review this authentication code",
    "Documentation for this API",
    "Write a security review of this code",
    "Create documentation for this API",
    "Should I refactor this module?",
    "Tell me how to fix this bug",
    "Can you explain how to implement this API?",
    "I want a plan to implement this API",
    "Draft a proposal for how we should refactor this module",
    "Do not fix this bug; just explain it",
    "Don't implement this API",
    "Never refactor this module",
    "I am writing about how to fix bugs in Python.",
    "Update me on the API status.",
    "Add the API details to the documentation.",
    "Remove this app from the comparison.",
    "Rename the project in this report.",
    "Build a report about this application.",
    "Update the API documentation.",
    "Update the README for this API.",
    "Add examples to the API guide.",
    "Fix typos in the API documentation.",
    "Build a React tutorial.",
    "Explain how to implement and fix this API.",
    "Teach me how to debug and repair this service.",
  ]) {
    assert.equal(hasLocalLLMCodeIntent(goal, "auto"), false, goal);
  }
  for (const { language, implementation, explanation } of [
    {
      language: "en",
      implementation: "Implement the authentication service",
      explanation: "Explain how to implement the authentication service",
    },
    {
      language: "ar",
      implementation: "نفّذ المصادقة وأضف اختبارات",
      explanation: "اشرح كيفية تنفيذ المصادقة دون تعديل الكود",
    },
    {
      language: "es",
      implementation: "Implementa la autenticación y añade pruebas",
      explanation: "Explica cómo implementar la autenticación sin modificar el código",
    },
    {
      language: "fr",
      implementation: "Implémentez l’authentification et ajoutez des tests",
      explanation: "Expliquez comment implémenter l’authentification sans modifier le code",
    },
    {
      language: "ja",
      implementation: "ログイン機能を実装してテストを追加してください",
      explanation: "ログイン機能の実装方法を説明してください。コードは変更しないでください",
    },
    {
      language: "ko",
      implementation: "로그인 기능을 구현하고 테스트를 추가해 주세요",
      explanation: "로그인 기능 구현 방법을 설명해 주세요. 코드는 수정하지 마세요",
    },
    {
      language: "vi",
      implementation: "Triển khai đăng nhập và thêm kiểm thử",
      explanation: "Giải thích cách triển khai đăng nhập mà không sửa mã",
    },
    {
      language: "zh-Hans",
      implementation: "实现登录功能并添加测试",
      explanation: "请解释如何实现登录功能，不要修改代码",
    },
    {
      language: "zh-Hant",
      implementation: "實作登入功能並新增測試",
      explanation: "請解釋如何實作登入功能，不要修改程式碼",
    },
    {
      language: "de",
      implementation: "Implementiere die Anmeldung und füge Tests hinzu",
      explanation: "Erkläre, wie man die Anmeldung implementiert, ohne den Code zu ändern",
    },
    {
      language: "ru",
      implementation: "Реализуй аутентификацию и добавь тесты",
      explanation: "Объясни, как реализовать аутентификацию, не изменяя код",
    },
  ]) {
    assert.equal(hasLocalLLMCodeIntent(implementation, "auto"), true, `${language}: ${implementation}`);
    assert.equal(hasLocalLLMCodeIntent(explanation, "auto"), false, `${language}: ${explanation}`);
  }
  for (const goal of [
    "不要实现登录功能",
    "不要實作登入功能",
    "ログイン機能を実装しないでください",
    "로그인 기능을 구현하지 마세요",
    "No implementes la autenticación",
    "N’implémentez pas l’authentification",
    "Implementiere die Anmeldung nicht",
    "Не реализуй аутентификацию",
    "لا تنفذ المصادقة",
    "Đừng triển khai đăng nhập",
  ]) {
    assert.equal(hasLocalLLMCodeIntent(goal, "auto"), false, `negated implementation: ${goal}`);
  }
  for (const goal of [
    "Expliquez comment implémenter et corriger cette API",
    "Giải thích cách triển khai và sửa API",
    "请解释如何实现并修复这个接口",
    "ログインを実装して修正する方法を説明してください",
    "로그인을 구현하고 수정하는 방법을 설명해 주세요",
  ]) {
    assert.equal(hasLocalLLMCodeIntent(goal, "auto"), false, `joined explanation actions: ${goal}`);
  }
  for (const goal of [
    "审查代码并修复错误",
    "コードをレビューしてバグを修正してください",
    "코드를 검토하고 버그를 수정해 주세요",
    "Revisa el código y corrige el error",
    "Examinez le code et corrigez le bug",
    "Überprüfe den Code und behebe den Fehler",
    "Проверь код и исправь ошибку",
    "راجع الكود وأصلح الخطأ",
    "Xem xét mã và sửa lỗi",
  ]) {
    assert.equal(hasLocalLLMCodeIntent(goal, "auto"), true, `advisory plus implementation: ${goal}`);
  }
  for (const { taskProfile, goal } of [
    { taskProfile: "chatops", goal: "Implement authentication" },
    { taskProfile: "shell", goal: "Create a bash script" },
    { taskProfile: "data", goal: "Write a Python ETL script" },
    { taskProfile: "r-stan", goal: "Implement this Stan model" },
    { taskProfile: "github", goal: "Implement the requested change" },
    { taskProfile: "maintenance", goal: "Implement the requested change" },
  ]) {
    assert.equal(hasLocalLLMCodeIntent(goal, taskProfile), true, `${taskProfile}: ${goal}`);
  }
  for (const taskProfile of [
    "writing",
    "research",
    "paper",
    "book",
    "novel",
    "design",
    "docs",
    "slides",
    "education",
    "image",
  ]) {
    assert.equal(
      hasLocalLLMCodeIntent("Implement authentication and fix the login bug.", taskProfile),
      false,
      `non-code task profile escaped its specialist route: ${taskProfile}`
    );
  }
  assert.equal(
    hasLocalLLMCodeIntent("Explain the tradeoffs, then implement the API fix.", "auto"),
    true,
  );

  const candidate = resolveRuntimeConfig(
    { goal: codeGoal, taskProfile: "code" },
    { baseDir: smokeProject, provider: "localllm", routingMode: "smart", enableScs: "off" }
  );
  assert.equal(candidate.model, "localllm-deep", "phase one must use the safe Deep fallback");
  assert.equal(candidate.localCodeCandidate, true);
  assert.equal(candidate.localCodeModel, "localllm-code");
  assert.equal(candidate.localSelection, "code-readiness-pending");

  const configuredMainMax = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    mainModel: "localllm-max",
    goal: codeGoal,
    taskProfile: "code",
  });
  assert.equal(configuredMainMax.model, "localllm-deep");
  assert.equal(configuredMainMax.localTier, "deep");
  assert.equal(configuredMainMax.localCodeCandidate, true);
  assert.equal(configuredMainMax.localCodeFallbackModel, "localllm-deep");
  assert.equal(configuredMainMax.requiresResourcePreflight, false);

  const scsConfiguredMainMax = resolveRuntimeConfig(
    { goal: codeGoal, taskProfile: "code" },
    {
      baseDir: smokeProject,
      provider: "localllm",
      routingMode: "smart",
      mainModel: "localllm-max",
      enableScs: "auto",
    }
  );
  assert.equal(scsConfiguredMainMax.scsActive, true);
  assert.equal(scsConfiguredMainMax.model, "localllm-deep");
  assert.equal(scsConfiguredMainMax.localTier, "deep");
  assert.equal(scsConfiguredMainMax.localCodeCandidate, true);
  assert.equal(scsConfiguredMainMax.scsModelPolicy, "selected");
  assert.equal(scsConfiguredMainMax.requiresResourcePreflight, false);

  const explicitTopLevelMax = selectModelRoute({
    provider: "localllm",
    model: "localllm-max",
    routingMode: "smart",
    mainModel: "localllm-deep",
    goal: codeGoal,
    taskProfile: "code",
  });
  assert.equal(explicitTopLevelMax.routingMode, "manual");
  assert.equal(explicitTopLevelMax.model, "localllm-max");
  assert.equal(explicitTopLevelMax.localTier, "max");
  assert.equal(explicitTopLevelMax.requiresResourcePreflight, true);
  assert.equal(explicitTopLevelMax.localCodeCandidate, undefined);

  const writingRoute = resolveRuntimeConfig(
    { goal: "Write an essay about why engineers refactor source code.", taskProfile: "writing" },
    { baseDir: smokeProject, provider: "localllm", routingMode: "smart", enableScs: "off" }
  );
  assert.equal(writingRoute.localCodeCandidate, false);
  assert.notEqual(writingRoute.localSelection, "code-readiness-pending");
  const researchRoute = resolveRuntimeConfig(
    { goal: "Research current methods for debugging Python services.", taskProfile: "research" },
    { baseDir: smokeProject, provider: "localllm", routingMode: "smart", enableScs: "off" }
  );
  assert.equal(researchRoute.localCodeCandidate, false);
  assert.notEqual(researchRoute.localSelection, "code-readiness-pending");

  const selectedDecision = resolveLocalCodeRoute(
    candidate,
    readiness(["localllm-fast", "localllm-deep", "localllm-code"])
  );
  assert.equal(selectedDecision.outcome, LOCALLLM_CODE_ROUTE_OUTCOMES.SELECTED);
  const selectedConfig = applyLocalCodeRoute(candidate, selectedDecision);
  assert.equal(selectedConfig.model, "localllm-code");
  assert.equal(selectedConfig.localTier, "code");
  assert.equal(selectedConfig.requiresResourcePreflight, false);
  assert.equal(isLocalAutoMaxCandidate(selectedConfig), false);

  const unauthenticatedDecision = resolveLocalCodeRoute(
    candidate,
    readiness(["localllm-fast", "localllm-deep", "localllm-code"], { authenticated: false })
  );
  assert.equal(unauthenticatedDecision.outcome, LOCALLLM_CODE_ROUTE_OUTCOMES.READINESS_UNVERIFIED);
  assert.equal(applyLocalCodeRoute(candidate, unauthenticatedDecision).model, "localllm-deep");

  const missingDecision = resolveLocalCodeRoute(candidate, readiness(["localllm-fast", "localllm-deep"]));
  assert.equal(missingDecision.outcome, LOCALLLM_CODE_ROUTE_OUTCOMES.MODEL_UNAVAILABLE);
  const fallbackConfig = applyLocalCodeRoute(candidate, missingDecision);
  assert.equal(fallbackConfig.model, "localllm-deep");
  assert.equal(fallbackConfig.localSelection, "runtime-code-fallback");
  assert.equal(isLocalAutoMaxCandidate(fallbackConfig), false, "code fallback must stay on Deep rather than spill into Max");

  const policy = captureLocalCodePolicy(candidate);
  assert.deepEqual(Object.keys(policy).sort(), ["candidateModel", "eligible", "fallbackModel", "schemaVersion"]);
  const restored = restoreLocalCodePolicy(
    { ...candidate, localCodeCandidate: false, localCodeModel: "", localCodeFallbackModel: "" },
    policy
  );
  assert.equal(restored.localCodeResumeEligible, true);
  assert.equal(restored.localCodeModel, "localllm-code");

  process.env.AGINTI_LOCALLLM_CODE_MODEL = "team-code-capability";
  const configuredCandidate = resolveRuntimeConfig(
    { goal: codeGoal, taskProfile: "code" },
    { baseDir: smokeProject, provider: "localllm", routingMode: "smart", enableScs: "off" }
  );
  assert.equal(configuredCandidate.localCodeModel, "team-code-capability");
  assert.equal(
    resolveLocalCodeRoute(configuredCandidate, readiness(["localllm-fast", "localllm-deep", "localllm-code"]))
      .outcome,
    LOCALLLM_CODE_ROUTE_OUTCOMES.MODEL_UNAVAILABLE,
    "availability must match the configured alias exactly"
  );
  assert.equal(
    resolveLocalCodeRoute(configuredCandidate, readiness(["localllm-fast", "localllm-deep", "team-code-capability"]))
      .outcome,
    LOCALLLM_CODE_ROUTE_OUTCOMES.SELECTED
  );
  delete process.env.AGINTI_LOCALLLM_CODE_MODEL;

  process.env.DEEPSEEK_API_KEY = "ambient-not-real";
  process.env.OPENAI_API_KEY = "ambient-not-real";
  process.env.LLM_BASE_URL = "https://hosted.example.invalid/v1";
  process.env.LLM_MODEL = "ambient-cloud-model";
  const localAgainstAmbientCloud = resolveRuntimeConfig(
    { goal: codeGoal, taskProfile: "code", provider: "localllm" },
    { baseDir: smokeProject, provider: "localllm", routingMode: "smart", enableScs: "off" }
  );
  assert.equal(localAgainstAmbientCloud.provider, "localllm");
  assert.equal(localAgainstAmbientCloud.model, "localllm-deep");
  assert.equal(localAgainstAmbientCloud.localCodeModel, "localllm-code");
  const explicitHosted = selectModelRoute({
    provider: "deepseek",
    routingMode: "smart",
    goal: codeGoal,
    taskProfile: "code",
  });
  assert.equal(explicitHosted.provider, "deepseek");
  assert.equal(explicitHosted.model, "deepseek-v4-pro");
  assert.equal(explicitHosted.localCodeCandidate, undefined);
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;

  const integrationRoot = path.join(smokeRoot, "integration");
  await fs.mkdir(integrationRoot, { recursive: true });
  await withProviderFixture(async ({ baseURL, fixture }) => {
      const selectedRun = await integrationConfig({
        root: integrationRoot,
        id: "code-selected",
        baseURL,
      });
      await runAgent(selectedRun.config);
      assert.deepEqual(selectedRun.observed.factoryModels, ["localllm-code"]);
      assert.ok(selectedRun.observed.requestModels.every((model) => model === "localllm-code"));
      assert.equal(selectedRun.observed.resourceProbes, 0);
      let selectedState = JSON.parse(
        await fs.readFile(path.join(selectedRun.config.sessionsDir, "code-selected", "state.json"), "utf8")
      );
      assert.equal(selectedState.model, "localllm-code");
      assert.equal(selectedState.meta.runtimeConfig.model, "localllm-code");
      assert.equal(selectedState.meta.localCodePolicy.eligible, true);

      const selectedResume = await integrationConfig({
        root: integrationRoot,
        id: "code-selected",
        baseURL,
        resume: true,
      });
      await runAgent(selectedResume.config);
      assert.deepEqual(selectedResume.observed.factoryModels, ["localllm-code"]);
      assert.ok(selectedResume.observed.requestModels.every((model) => model === "localllm-code"));
      assert.equal(selectedResume.observed.resourceProbes, 0);

      fixture.codeAvailable = false;
      const fallbackRun = await integrationConfig({
        root: integrationRoot,
        id: "code-fallback",
        baseURL,
      });
      await runAgent(fallbackRun.config);
      assert.deepEqual(fallbackRun.observed.factoryModels, ["localllm-deep"]);
      assert.ok(fallbackRun.observed.requestModels.every((model) => model === "localllm-deep"));
      assert.equal(fallbackRun.observed.resourceProbes, 0);
      let fallbackState = JSON.parse(
        await fs.readFile(path.join(fallbackRun.config.sessionsDir, "code-fallback", "state.json"), "utf8")
      );
      assert.equal(fallbackState.meta.runtimeConfig.model, "localllm-deep");
      assert.equal(fallbackState.meta.localCodePolicy.eligible, true);

      fixture.codeAvailable = true;
      const fallbackResume = await integrationConfig({
        root: integrationRoot,
        id: "code-fallback",
        baseURL,
        resume: true,
      });
      await runAgent(fallbackResume.config);
      assert.deepEqual(fallbackResume.observed.factoryModels, ["localllm-code"]);
      assert.ok(fallbackResume.observed.requestModels.every((model) => model === "localllm-code"));
      assert.equal(fallbackResume.observed.resourceProbes, 0);
      fallbackState = JSON.parse(
        await fs.readFile(path.join(fallbackRun.config.sessionsDir, "code-fallback", "state.json"), "utf8")
      );
      assert.equal(fallbackState.meta.runtimeConfig.model, "localllm-code");

      const eventLines = await fs.readFile(
        path.join(fallbackRun.config.sessionsDir, "code-fallback", "events.jsonl"),
        "utf8"
      );
      const codeEvents = eventLines
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "provider.local_code_route");
      assert.deepEqual(codeEvents.map((event) => event.data.outcome), ["model-unavailable", "selected"]);
      assert.ok(codeEvents.every((event) => event.data.authenticatedDiscovery === true));
      assert.equal(fixture.modelRequests, 4);
      assert.equal(fixture.authenticatedModelRequests, 4);
  });

  console.log("LocalLLM authenticated coding route smoke passed (offline; no model loads).\n");
} finally {
  for (const key of Object.keys(process.env)) {
    if (CONFIG_ENV_PATTERN.test(key)) delete process.env[key];
  }
  await fs.rm(smokeRoot, { recursive: true, force: true });
}
