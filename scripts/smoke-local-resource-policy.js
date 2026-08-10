#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  assessLocalMaxResources,
  parseLinuxMeminfo,
  parseNvidiaMemoryCsv,
  probeLocalMaxResources,
} from "../src/local-resource-policy.js";

const GiB = 1024 ** 3;

const parsedMemory = parseLinuxMeminfo(`MemTotal:       65536000 kB
MemAvailable:   33554432 kB
SwapTotal:       8388608 kB
SwapFree:        4194304 kB
`);
assert.equal(parsedMemory.availableBytes, 32 * GiB);
assert.equal(parsedMemory.swapTotalBytes, 8 * GiB);
assert.equal(parsedMemory.swapFreeBytes, 4 * GiB);

assert.deepEqual(parseNvidiaMemoryCsv("22000, 24564\n21000, 24564\n"), [
  { freeMiB: 22000, totalMiB: 24564 },
  { freeMiB: 21000, totalMiB: 24564 },
]);

const ready = assessLocalMaxResources({
  memory: parsedMemory,
  gpus: [
    { freeMiB: 22000, totalMiB: 24564 },
    { freeMiB: 21000, totalMiB: 24564 },
  ],
});
assert.equal(ready.ready, true);

const pressured = assessLocalMaxResources({
  memory: {
    availableBytes: 20 * GiB,
    swapTotalBytes: 8 * GiB,
    swapFreeBytes: 1 * GiB,
  },
  gpus: [
    { freeMiB: 7000, totalMiB: 24564 },
    { freeMiB: 24000, totalMiB: 24564 },
  ],
});
assert.equal(pressured.ready, false);
assert.deepEqual(pressured.reasons, [
  "available-ram-below-24-gib",
  "swap-use-above-75-percent",
  "aggregate-gpu-free-below-40-gib",
]);

const exactlySeventyFivePercentSwap = assessLocalMaxResources({
  memory: {
    availableBytes: 32 * GiB,
    swapTotalBytes: 8 * GiB,
    swapFreeBytes: 2 * GiB,
  },
  gpus: [
    { freeMiB: 22000, totalMiB: 24564 },
    { freeMiB: 22000, totalMiB: 24564 },
  ],
});
assert.equal(exactlySeventyFivePercentSwap.ready, true, "exactly 75% swap use is permitted by workstation policy");

const aboveSeventyFivePercentSwap = assessLocalMaxResources({
  memory: {
    availableBytes: 32 * GiB,
    swapTotalBytes: 8 * GiB,
    swapFreeBytes: 2 * GiB - 1,
  },
  gpus: [
    { freeMiB: 22000, totalMiB: 24564 },
    { freeMiB: 22000, totalMiB: 24564 },
  ],
});
assert.equal(aboveSeventyFivePercentSwap.ready, false);
assert.ok(aboveSeventyFivePercentSwap.reasons.includes("swap-use-above-75-percent"));

let commands = 0;
const probed = await probeLocalMaxResources({
  readFile: async () => `MemTotal:       67108864 kB
MemAvailable:   41943040 kB
SwapTotal:       8388608 kB
SwapFree:        4194304 kB
`,
  exec: async (command, args) => {
    commands += 1;
    assert.equal(command, "nvidia-smi");
    assert.deepEqual(args, ["--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"]);
    return { stdout: "23000, 24564\n23000, 24564\n" };
  },
  platform: "linux",
});
assert.equal(probed.ready, true);
assert.equal(commands, 1);

const noGpu = await probeLocalMaxResources({
  readFile: async () => `MemTotal:       67108864 kB
MemAvailable:   41943040 kB
SwapTotal:              0 kB
SwapFree:               0 kB
`,
  exec: async () => {
    throw new Error("nvidia-smi unavailable");
  },
  platform: "linux",
});
assert.equal(noGpu.ready, false);
assert.ok(noGpu.reasons.includes("nvidia-memory-unavailable"));

console.log("LocalLLM Max resource policy smoke passed (offline; no model loads).\n");
