import assert from "node:assert/strict";

import { selectProgressiveTools } from "../src/progressive-tool-selection.js";

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
  `^output/wechat_worker/daily-research-task(?:/.*)?$`
);
assert.equal(
  byName.get("list_files").function.parameters.properties.path.pattern,
  `^output/wechat_worker/daily-research-task(?:/.*)?$`
);
assert.equal(
  byName.get("list_files").function.parameters.properties.path.enum,
  undefined,
  "safe child directories must remain listable inside the exact artifact root"
);

console.log("scoped artifact research smoke passed");
