import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isReadOnlyAwkCommand, isReadOnlyAwkProgram } from "../src/readonly-awk.js";
import { classifyCommand, evaluateCommandPolicy } from "../src/command-policy.js";

const config = { sandboxMode: "host", packageInstallPolicy: "block", allowShellTool: true, allowFileTools: true, allowDestructive: false };
const observed = "awk -F, 'NR>1{n++; s+=$4; if(n==1||$4<mn)mn=$4; if(n==1||$4>mx)mx=$4} END{printf \"n=%d sum=%.6f mean=%.6f min=%g max=%g range=%g\\n\", n, s, s/n, mn, mx, mx-mn}' clean.csv";
const positive = [
  ["{print $1}", "awk '{print $1}' values.txt"],
  ["NR>1{n++;s+=$4} END{print n,s/n}", "awk -F, 'NR>1{n++;s+=$4} END{print n,s/n}' clean.csv"],
  ["BEGIN{n=0} {++n} END{printf(\"%d\\n\",n)}", "awk 'BEGIN{n=0} {++n} END{printf(\"%d\\n\",n)}' ./values.txt"],
  ["NR>1&&NF>2{if($3<0){n+=1}else{n+=2}} END{print n}", "awk -F , 'NR>1&&NF>2{if($3<0){n+=1}else{n+=2}} END{print n}' data/values.csv"],
  ["{n++;s+=$1;s-=0;s*=1;s/=1;s%=100;s^=1;n--;++n} END{print n,s}", "awk '{n++;s+=$1;s-=0;s*=1;s/=1;s%=100;s^=1;n--;++n} END{print n,s}' values.txt"],
  ["BEGIN{print(1>0);printf(\"%d\\n\",(2>3))}", "awk 'BEGIN{print(1>0);printf(\"%d\\n\",(2>3))}' values.txt"],
  ['BEGIN{print "system(getline) > label; $(literal)"}', 'awk \'BEGIN{print "system(getline) > label; $(literal)"}\' values.txt'],
  ["BEGIN{print 1+2*3,2^3,-1,.25,1e-3}", "awk 'BEGIN{print 1+2*3,2^3,-1,.25,1e-3}' 'values table.txt'"],
  ["{print $0}", "awk -F'\\t' -- '{print $0}' \"值表.tsv\""],
  ["{n++}\nEND{print n}", "awk '{n++}\nEND{print n}' values.txt"],
  ['BEGIN{print "}","if","(","print",";"}', 'awk \'BEGIN{print "}","if","(","print",";"}\' values.txt'],
];
for (const [program, command] of positive) test("bounded AWK positive: " + JSON.stringify(program), () => {
  assert.equal(isReadOnlyAwkProgram(program), true);
  assert.equal(isReadOnlyAwkCommand(command), true);
  const result = evaluateCommandPolicy(command, config);
  assert.equal(result.allowed, true); assert.equal(result.category, "read-only");
  assert.equal(result.writesWorkspace, false); assert.equal(result.needsNetwork, false);
});

const negativePrograms = [
  'BEGIN{system("touch marker")}', 'BEGIN{print "x" > "marker"}', 'BEGIN{printf "%s","x" >> "marker"}',
  'BEGIN{print "x" | "sh"}', 'BEGIN{print "x" |& "sh"}', 'BEGIN{getline x < "input"}',
  'BEGIN{"sh" | getline x}', 'BEGIN{close("x")}', 'BEGIN{fflush()}', 'BEGIN{ENVIRON["X"]="y"}',
  'BEGIN{ARGV[1]="input"}', 'BEGIN{ARGC=0}', 'BEGIN{FILENAME="x"}', 'BEGIN{FS=","}', 'BEGIN{RS="x"}',
  'BEGIN{OFS=","}', 'BEGIN{PROCINFO["sorted_in"]="x"}', 'BEGIN{for(i=0;i<2;i++)print i}',
  'BEGIN{while(1)print 1}', 'BEGIN{do{n++}while(n<2)}', 'function f(){print 1} BEGIN{f()}',
  '@include "input"', '@load "input"', 'BEGINFILE{print 1}', 'ENDFILE{print 1}',
  'BEGIN{f="system";@f("x")}', 'BEGIN{printf fmt,1}', 'BEGIN{printf "%*s",1,"x"}',
  'BEGIN{printf "%999s","x"}', 'BEGIN{printf "%.99f",1}', 'BEGIN{printf "%n",1}',
  'BEGIN{printf "%s",1 > 2+3}', 'BEGIN{print ("x") > "marker"}', 'BEGIN{printf("%s","x") > "marker"}',
  'BEGIN{print sprintf("%s","x")}', 'BEGIN{print sqrt(4)}', '{print $(NF)}', '{print $257}',
  '{print $00}', 'BEGIN{print undeclared}', 'BEGIN{print 1e999}', 'BEGIN{print "\\x73ystem"}',
  'BEGIN{print "\\163ystem"}', 'BEGIN{print "unterminated}', 'BEGIN{print 1} trailing',
  'BEGIN{print 1 # comment\n}', 'BEGIN{print 1}\u0000', 'BEGIN{print 1}\r',
  '{' + '{'.repeat(17) + 'print 1' + '}'.repeat(18),
  'BEGIN{print ' + '('.repeat(18) + '1' + ')'.repeat(18) + '}',
  'BEGIN{' + 'n++;'.repeat(129) + '}', 'BEGIN{' + '\n'.repeat(513) + '}',
  'BEGIN{print 1}'.repeat(17), ' '.repeat(4097),
];
for (const program of negativePrograms) test("unsafe/unsupported AWK program: " + JSON.stringify(program).slice(0, 100), () => {
  assert.equal(isReadOnlyAwkProgram(program), false);
  const command = "awk '" + program + "' input.csv";
  assert.equal(isReadOnlyAwkCommand(command), false);
  assert.notEqual(classifyCommand(command).category, "read-only");
  assert.equal(evaluateCommandPolicy(command, config).allowed, false);
});

const negativeCommands = [
  "awk\u00a0'{print $1}' input.csv", "awk\u2003'{print $1}' input.csv",
  "awk\ufeff'{print $1}' input.csv", "awk\v'{print $1}' input.csv",
  "awk -f script.awk input.csv", "awk --source '{print $1}' input.csv", "awk -W exec script.awk input.csv",
  "awk -v name=1 '{print $1}' input.csv", "awk '{print $1}'", "awk '{print $1}' -",
  "awk '{print $1}' ARGV=bad", "awk '{print $1}' name=1", "awk '{print $1}' --load=bad",
  "awk '{print $1}' *.csv", "awk '{print $1}' ../input.csv", "awk '{print $1}' a/../input.csv",
  "awk '{print $1}' /etc/passwd", "awk '{print $1}' /dev/fd/3",
  'awk "{print $1}" input.csv', "awk 'BEGIN{print 1}' input.csv > marker",
  "awk 'BEGIN{print 1}' input.csv; touch marker",
  "awk 'BEGIN{print 1}' input.csv | sh", "awk 'BEGIN{print 1}' input.csv &",
  "awk 'BEGIN{print 1}' $(printf input.csv)", "awk 'BEGIN{print 1}' `printf input.csv`",
  "awk 'BEGIN{print 1}' input\\.csv", "awk '{print '\"'\"'$1}' input.csv",
  "awk -F'[,;]' '{print $1}' input.csv", "gawk '{print $1}' input.csv",
  "awk '{print $1}' " + Array.from({ length: 17 }, (_, i) => `file${i}.csv`).join(" "),
];
for (const command of negativeCommands) test("unsafe/unsupported AWK invocation: " + command.slice(0, 100), () => {
  assert.equal(isReadOnlyAwkCommand(command), false);
  assert.notEqual(classifyCommand(command).category, "read-only");
  assert.equal(evaluateCommandPolicy(command, config).allowed, false);
});

test("credential-path denial remains independent of the AWK syntax classifier", () => {
  const command = "awk '{print $1}' .env";
  assert.equal(isReadOnlyAwkCommand(command), true);
  const result = evaluateCommandPolicy(command, config);
  assert.equal(result.allowed, false); assert.equal(result.category, "blocked");
});

test("shell whitespace must match actual shell separators", () => {
  const command = "awk '{print $1}' input.csv";
  for (const char of ["\u00a0", "\u2003", "\ufeff", "\v", "\f"]) {
    assert.equal(isReadOnlyAwkCommand(char + command), false);
    assert.equal(isReadOnlyAwkCommand(command + char), false);
  }
  assert.equal(isReadOnlyAwkCommand(" \t" + command + "\t "), true);
});

test("a mixed network sequence retains network authority rather than read-only classification", () => {
  const network = "curl https://example.com";
  const command = "awk 'BEGIN{print 1}' input.csv && " + network;
  assert.equal(isReadOnlyAwkCommand(command), false);
  const result = evaluateCommandPolicy(command, config);
  assert.notEqual(result.category, "read-only"); assert.equal(result.needsNetwork, true);
  assert.equal(result.allowed, evaluateCommandPolicy(network, config).allowed);
});

test("exact observed numeric verification sequence is read-only without stronger trust", () => {
  const command = 'echo "== clean.csv =="; cat clean.csv; echo; echo "== AWK CHECK =="; ' + observed;
  const result = evaluateCommandPolicy(command, config);
  assert.equal(result.allowed, true); assert.equal(result.category, "read-only");
  assert.equal(result.writesWorkspace, false); assert.equal(result.needsNetwork, false);
  assert.equal(evaluateCommandPolicy(command, { ...config, allowShellTool: false }).allowed, false);
});

test("real system AWK inspection prints correct arithmetic and changes no input or files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-readonly-awk-"));
  try {
    const source = "sensor,observed_at,reading,value\na,t,2.5,2.5\nb,t,-1,-1\nc,t,4,4\n";
    await fs.writeFile(path.join(temp, "clean.csv"), source);
    const before = await fs.stat(path.join(temp, "clean.csv"), { bigint: true });
    const result = spawnSync("/bin/sh", ["-c", observed], { cwd: temp, encoding: "utf8", timeout: 3000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "n=3 sum=5.500000 mean=1.833333 min=-1 max=4 range=5\n");
    assert.equal(await fs.readFile(path.join(temp, "clean.csv"), "utf8"), source);
    const after = await fs.stat(path.join(temp, "clean.csv"), { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[key], before[key]);
    assert.deepEqual(await fs.readdir(temp), ["clean.csv"]);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
