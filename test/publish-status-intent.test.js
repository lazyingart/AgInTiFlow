import assert from "node:assert/strict";
import test from "node:test";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

const cases = [
  ["Chinese saved-session status", "请继续这个会话，重新读一下 summary.md，用中文说清延迟从多少变为多少、是否部署，以及还要检查什么。不要修改任何文件。", false],
  ["Chinese whether already deployed", "请告诉我服务是否已经部署，不要改文件。", false],
  ["Chinese has any deployment", "请检查服务有没有部署，不能改配置。", false],
  ["Chinese explicit status noun", "请检查服务部署状态，不要改文件。", false],
  ["traditional Chinese status", "請告訴我是否已經發布，不要修改檔案。", false],
  ["English decision question", "Please report whether we need to deploy; do not modify files.", false],
  ["English infinitive question", "Could you tell me whether to publish the package?", false],
  ["English modal question", "Please check if we should deploy the build.", false],
  ["ordinary past-tense status", "Please tell me whether deployment happened.", false],
  ["Chinese imperative", "请部署服务。", true],
  ["Chinese mixed observation and action", "请先检查是否已经部署，然后部署这个版本。", true],
  ["Chinese status then publication", "请检查服务部署状态，然后发布新版本。", true],
  ["Chinese deploy status page", "请部署状态页面。", true],
  ["English mixed observation and action", "Please report whether we need to deploy, then deploy the approved build.", true],
  ["English conditional action", "If validation passes, please deploy.", true],
  ["English referential conditional action", "Please check if we should deploy and if so do so.", true],
  ["unconditional despite decision", "Please publish whether or not tests pass.", true],
];
for (const [label, goal, expected] of cases) test(`publication intent: ${label}`, () => {
  for (const taskProfile of ["code", "auto", "general"]) {
    const contract = deriveScsTaskContract({ goal, taskProfile });
    assert.equal(contract.requiredEvidence.some(item => item.category === "publish"), expected, taskProfile);
  }
});
