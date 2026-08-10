import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCALLLM_MAX_MIN_AVAILABLE_RAM_BYTES = 24 * 1024 ** 3;
export const LOCALLLM_MAX_SWAP_PRESSURE_RATIO = 0.75;
// The installed Q8 alias is about 32 GB on disk. Keep a conservative 8+ GiB
// working reserve for runtime/KV allocations instead of silently CPU-offloading.
export const LOCALLLM_MAX_MIN_AGGREGATE_GPU_FREE_MIB = 40 * 1024;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function parseLinuxMeminfo(value = "") {
  const values = new Map();
  for (const line of String(value).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  return {
    totalBytes: finiteNonNegative(values.get("MemTotal")),
    availableBytes: finiteNonNegative(values.get("MemAvailable")),
    swapTotalBytes: finiteNonNegative(values.get("SwapTotal")),
    swapFreeBytes: finiteNonNegative(values.get("SwapFree")),
  };
}

export function parseNvidiaMemoryCsv(value = "") {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [free, total] = line.split(",").map((item) => Number(item.trim()));
      return { freeMiB: free, totalMiB: total };
    })
    .filter(({ freeMiB, totalMiB }) => Number.isFinite(freeMiB) && Number.isFinite(totalMiB) && freeMiB >= 0 && totalMiB > 0);
}

export function assessLocalMaxResources({
  memory = {},
  gpus = [],
  minAvailableRamBytes = LOCALLLM_MAX_MIN_AVAILABLE_RAM_BYTES,
  maxSwapPressureRatio = LOCALLLM_MAX_SWAP_PRESSURE_RATIO,
  minAggregateGpuFreeMiB = LOCALLLM_MAX_MIN_AGGREGATE_GPU_FREE_MIB,
} = {}) {
  const availableRamBytes = finiteNonNegative(memory.availableBytes);
  const swapTotalBytes = finiteNonNegative(memory.swapTotalBytes);
  const swapFreeBytes = Math.min(swapTotalBytes, finiteNonNegative(memory.swapFreeBytes));
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);
  const swapPressureRatio = swapTotalBytes > 0 ? swapUsedBytes / swapTotalBytes : 0;
  const validGpus = Array.isArray(gpus)
    ? gpus.filter(
        ({ freeMiB, totalMiB }) =>
          Number.isFinite(Number(freeMiB)) && Number(freeMiB) >= 0 && Number.isFinite(Number(totalMiB)) && Number(totalMiB) > 0
      )
    : [];
  const aggregateGpuFreeMiB = validGpus.reduce((sum, gpu) => sum + Number(gpu.freeMiB), 0);
  const reasons = [];

  if (availableRamBytes < minAvailableRamBytes) reasons.push("available-ram-below-24-gib");
  if (swapPressureRatio > maxSwapPressureRatio) reasons.push("swap-use-above-75-percent");
  if (validGpus.length === 0) reasons.push("nvidia-memory-unavailable");
  else if (aggregateGpuFreeMiB < minAggregateGpuFreeMiB) reasons.push("aggregate-gpu-free-below-40-gib");

  return {
    ready: reasons.length === 0,
    status: reasons.length === 0 ? "ready" : "pressured",
    sharedWorkstationPressure: reasons.length > 0,
    reasons,
    metrics: {
      availableRamBytes,
      swapTotalBytes,
      swapUsedBytes,
      swapPressureRatio,
      gpuCount: validGpus.length,
      aggregateGpuFreeMiB,
      gpus: validGpus.map(({ freeMiB, totalMiB }) => ({ freeMiB: Number(freeMiB), totalMiB: Number(totalMiB) })),
    },
    thresholds: {
      minAvailableRamBytes,
      maxSwapPressureRatio,
      minAggregateGpuFreeMiB,
    },
  };
}

export async function probeLocalMaxResources({
  readFile = fs.readFile,
  exec = execFileAsync,
  platform = process.platform,
  signal,
} = {}) {
  let memory;
  if (platform === "linux") {
    try {
      memory = parseLinuxMeminfo(await readFile("/proc/meminfo", "utf8"));
    } catch {
      memory = null;
    }
  }
  if (!memory?.availableBytes) {
    memory = {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    };
  }

  let gpus = [];
  try {
    const { stdout } = await exec(
      "nvidia-smi",
      ["--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 2500, maxBuffer: 64 * 1024, signal }
    );
    gpus = parseNvidiaMemoryCsv(stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    gpus = [];
  }

  return assessLocalMaxResources({ memory, gpus });
}
