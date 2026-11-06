import fs from "node:fs/promises";

const target = process.env.AGINTI_TEST_HISTORY_EVENTS;
if (!target || !target.endsWith("/events.jsonl")) throw Error("History gate requires an explicit synthetic event path");
const read = fs.readFile, write = process.stdout.write;
let armed = false, used = false;
process.stdout.write = function (chunk, ...args) {
  if (typeof chunk === "string" && chunk.includes("runtimeRevision=")) armed = true;
  return Reflect.apply(write, this, [chunk, ...args]);
};
fs.readFile = async function (file, ...args) {
  if (armed && !used && file === target) {
    used = true;
    const ended = new Promise(resolve => process.stdin.once("end", resolve));
    process.stdout.write("TEST_HISTORY_INPUT_GATE\n");
    await ended;
    fs.readFile = read;
    process.stdout.write = write;
  }
  return Reflect.apply(read, fs, [file, ...args]);
};
globalThis.fetch = () => Promise.reject(Error("OFFLINE_NETWORK_REFUSED"));
