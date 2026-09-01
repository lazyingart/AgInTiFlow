import assert from "node:assert/strict";

import { completionTaskContract } from "../src/agent-runner.js";
import { selectProgressiveTools } from "../src/progressive-tool-selection.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

function tool(name, properties = {}) {
  return {
    type: "function",
    function: {
      name,
      parameters: {
        type: "object",
        properties,
        additionalProperties: false,
      },
    },
  };
}

const pathProperty = { path: { type: "string" } };
const allTools = [
  tool("list_files", pathProperty),
  tool("read_file", pathProperty),
  tool("search_files", pathProperty),
  tool("write_file", pathProperty),
  tool("apply_patch", pathProperty),
  tool("run_command", { command: { type: "string" } }),
  tool("deep_research", { query: { type: "string" } }),
  tool("web_search", { query: { type: "string" } }),
  tool("read_web_page", { url: { type: "string" } }),
  tool("web_research", { query: { type: "string" } }),
  tool("open_url", { url: { type: "string" } }),
  tool("send_to_canvas", {}),
  tool("finish", { result: { type: "string" } }),
];

const artifactRoot = "output/wechat_worker/daily-research-task";
const goal = `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
  mode: "task",
  request: "Prepare a daily research briefing from current scholarly sources.",
  artifact_root: `/workspace/${artifactRoot}`,
})}`;
const selected = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    progressiveTools: true,
    scopedArtifactTask: true,
    scopedArtifactRoot: artifactRoot,
  },
  goal,
  profile: "auto",
  messages: [{ role: "user", content: goal }],
});
const byName = new Map(selected.map((item) => [item.function.name, item]));

assert(byName.has("deep_research"), "scoped research lost deep_research");
assert(byName.has("web_search"), "scoped research lost web_search");
assert(byName.has("read_web_page"), "scoped research lost read_web_page");
assert(byName.has("read_file"), "scoped research lost read_file");
assert(byName.has("write_file"), "scoped research lost write_file");
assert.equal(
  byName.get("read_file").function.parameters.properties.path.pattern,
  `^(?:output/wechat_worker/daily-research-task)(?:/.*)?$`
);
assert.equal(
  byName.get("list_files").function.parameters.properties.path.pattern,
  `^(?:output/wechat_worker/daily-research-task)(?:/.*)?$`
);
assert.equal(
  byName.get("list_files").function.parameters.properties.path.enum,
  undefined,
  "safe child directories must remain listable inside the exact artifact root"
);

const researchRequest =
  "Look into how browser agents recover from stale UI state and write me a useful short research note. Use real current sources, separate demonstrated facts from inference, and save the note so I can reuse it.";
const researchGoal = `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
  mode: "task",
  request: researchRequest,
  artifact_root: `/workspace/${artifactRoot}`,
})}`;
const researchContract = deriveScsTaskContract({
  goal: researchGoal,
  taskProfile: "auto",
});
assert.equal(
  researchContract.scopedArtifactDeliverable,
  true,
  "a requested note under the host-owned artifact root is a scoped deliverable"
);

function currentTurnState(currentRequest, activeContract = {}) {
  return {
    goal: currentRequest,
    meta: {
      taskProfile: "auto",
      goalContract: {
        revision: 1,
        activeGoalRevision: 1,
        currentRequest,
        currentPreview: currentRequest,
        activeGoal: currentRequest,
        taskGoal: currentRequest,
        history: [{ revision: 1, refreshExecutionContract: true }],
      },
      activeExecutionContract: {
        revision: 1,
        startedMutationRevision: 0,
        requiresWorkspaceMutation: true,
        requiresFileMutation: true,
        requiresSourceGrounding: false,
        requiredProjectCommands: [],
        ...activeContract,
      },
      projectVerification: { mutationRevision: 0 },
    },
  };
}

const completedResearchContract = completionTaskContract(
  { goal: researchGoal, taskProfile: "auto", commandCwd: "/workspace" },
  currentTurnState(researchGoal, { scopedArtifactDeliverable: true })
);
const researchFileEvidence = completedResearchContract.requiredEvidence.find(
  (item) => item.category === "file"
);
assert.equal(
  researchFileEvidence?.minimumMutationRevision || 0,
  0,
  "scoped deliverables must not require an unrelated project-source mutation"
);
assert.equal(completedResearchContract.requiredFreshMutationRevision, 0);

const codeRequest =
  "Fix the stale browser recovery logic in src/agent-runner.js and save a short report.";
const codeGoal = `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
  mode: "task",
  request: codeRequest,
  artifact_root: `/workspace/${artifactRoot}`,
})}`;
const codeContract = deriveScsTaskContract({ goal: codeGoal, taskProfile: "auto" });
assert.equal(
  codeContract.scopedArtifactDeliverable,
  false,
  "a sidecar report must not substitute for a requested source-code repair"
);
const guardedCodeContract = completionTaskContract(
  { goal: codeGoal, taskProfile: "auto", commandCwd: "/workspace" },
  currentTurnState(codeGoal)
);
const codeFileEvidence = guardedCodeContract.requiredEvidence.find(
  (item) => item.category === "file"
);
assert.equal(codeFileEvidence?.minimumMutationRevision, 1);
assert.equal(guardedCodeContract.requiredFreshMutationRevision, 1);

console.log("scoped artifact research smoke passed");
