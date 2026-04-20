import { runAgent } from "./src/agent-runner.js";
import { loadConfig } from "./src/config.js";

function parseArgs(argv) {
  const result = {
    goal: "",
    startUrl: "",
    resume: "",
    sessionId: "",
  };

  const parts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--start-url") {
      result.startUrl = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--resume") {
      result.resume = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--session-id") {
      result.sessionId = argv[i + 1] || "";
      i += 1;
      continue;
    }
    parts.push(arg);
  }

  result.goal = parts.join(" ").trim();
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (!args.goal && !args.resume) {
  console.error('Usage: npm start -- [--start-url https://example.com] [--resume session-id] "your task"');
  process.exit(1);
}

const config = loadConfig(args);

runAgent(config).catch((error) => {
  console.error(error);
  process.exit(1);
});
