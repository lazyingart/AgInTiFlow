import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/saved-result-lookup.js", import.meta.url));
for (const [scs, behavior] of [["on", "ordinary"], ["off", "ordinary"], ["on", "unoffered-read"], ["on", "empty-history"]]) test(`Flash → Pro saved-result lookup after restart, SCS ${scs}, ${behavior}`, {timeout:30000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-prior-answer-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const work=path.join(root,"work"), file=path.join(work,"queue.txt");
  await fs.mkdir(work);
  const second="SILVER OAK "+createHash("sha256").update(root).digest("hex").slice(0,8);
  await fs.writeFile(file,`ARCHIVE-OMIT-81\nOld entry\nEnd archive\nPAPER KITE\n${second}\n`);
  async function run(stage, instruction=behavior) {
    const {stdout}=await exec(process.execPath,[fixture,root,stage,scs,instruction],{cwd:work,timeout:12000,
      env:{HOME:root,PATH:process.env.PATH,LANG:"C.UTF-8",AGINTIFLOW_HOME:path.join(root,"agent-home"),
        AGINTIFLOW_NO_AUTO_UPDATE:"1",AGINTIFLOW_NO_WEB_AUTO_START:"1",AGINTIFLOW_HOUSEKEEPING:"0"}});
    return JSON.parse(stdout.trim().split("\n").at(-1));
  }
  const first=await run("initial");
  if (behavior === "empty-history") {
    const again=await run("resume");
    assert.equal(again.sessionId,first.sessionId);
    assert.match(first.result,/还没有先前的结果/);
    assert.equal(again.result,first.result);
    assert.deepEqual([first.requests,again.requests],[[],[]]);
    const retrieved=await run("resume","recover-source");
    assert.equal(retrieved.sessionId,first.sessionId);
    assert.equal(retrieved.result,"Recorded entries: PAPER KITE | "+second);
    return;
  }
  assert.equal(first.result,"Recorded entries: PAPER KITE | "+second);
  await fs.writeFile(file,"FRESH-ONLY-54\n"); // An intervening edit makes an accidental live read observable.
  const before=await fs.stat(file,{bigint:true});
  const next=await run("resume");
  assert.equal(next.sessionId,first.sessionId);
  assert.equal(next.result,`The recorded second item was ${second}.`);
  const expectedRequests = behavior === "unoffered-read" ? 2 : 1;
  assert.deepEqual(next.requests,Array.from({length:expectedRequests},()=>({model:"deepseek-v4-pro",tools:["finish"]})));
  const events=(await fs.readFile(path.join(root,"sessions",first.sessionId,"events.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
  const resume=events.findLastIndex(e=>e.type==="session.resumed");
  assert.ok(resume>0);assert.equal(events.slice(0,resume).filter(e=>e.type==="tool.started" && e.data.toolName==="read_file").length,1);
  assert.equal(events.slice(resume).filter(e=>e.type==="tool.started" && e.data.toolName!=="finish").length,0);
  const after=await fs.stat(file,{bigint:true});
  assert.deepEqual([after.ino,after.mtimeNs,after.ctimeNs],[before.ino,before.mtimeNs,before.ctimeNs]);
});
