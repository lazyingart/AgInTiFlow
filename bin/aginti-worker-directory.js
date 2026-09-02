#!/usr/bin/env node

import {
  INTEGRATION_WORKER_DIRECTORY_PLATFORMS,
  INTEGRATION_WORKER_DIRECTORY_ROLES,
  createIntegrationWorkerDirectory,
} from "../src/integration-worker-directory.js";
import { createSystemdExecutionWorkerBindingAuthority } from "../src/integration-execution-worker-router.js";

const HELP = `Usage: aginti-worker-directory <command> [options]

Read commands:
  status
  events
  resolve --role <role>

Mutation commands:
  enroll --node-id <id> --binding-id <id> --platform <platform> --roles <role,...>
  renew --node-id <id>
  switch --role <role> --node-id <id> --expected-generation <n>
  rollback --role <role> --expected-generation <n>
  finalize --role <role> --expected-generation <n>
  retire --node-id <id>
  remove --node-id <id>

The command reads only the fixed owner-only manifest and systemd credentials.
It never accepts an endpoint, host, port, URL, token, or credential name.

Roles: ${INTEGRATION_WORKER_DIRECTORY_ROLES.join(", ")}
Platforms: ${INTEGRATION_WORKER_DIRECTORY_PLATFORMS.join(", ")}
`;

const COMMAND_FLAGS = Object.freeze({
  status: Object.freeze([]),
  events: Object.freeze([]),
  resolve: Object.freeze(["role"]),
  enroll: Object.freeze(["node-id", "binding-id", "platform", "roles"]),
  renew: Object.freeze(["node-id"]),
  switch: Object.freeze(["role", "node-id", "expected-generation"]),
  rollback: Object.freeze(["role", "expected-generation"]),
  finalize: Object.freeze(["role", "expected-generation"]),
  retire: Object.freeze(["node-id"]),
  remove: Object.freeze(["node-id"]),
});
const PROBED_COMMANDS = new Set(["enroll", "renew", "switch", "rollback"]);

function usage(message) {
  const error = new Error(message);
  error.code = "WORKER_DIRECTORY_CLI_USAGE";
  error.status = 400;
  throw error;
}

function parse(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return Object.freeze({ command: "help", options: Object.freeze({}) });
  }
  const command = argv[0];
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) usage(`Unknown command: ${command}`);
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      usage("Options must use --name value pairs.");
    }
    const name = flag.slice(2);
    if (!allowed.includes(name)) usage(`Unsupported option for ${command}: --${name}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) usage(`Duplicate option: --${name}`);
    options[name] = value;
  }
  for (const name of allowed) {
    if (!Object.prototype.hasOwnProperty.call(options, name)) usage(`Missing option: --${name}`);
  }
  if (Object.prototype.hasOwnProperty.call(options, "expected-generation")) {
    generation(options["expected-generation"]);
  }
  return Object.freeze({ command, options: Object.freeze(options) });
}

function generation(value) {
  if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(String(value || ""))) {
    usage("--expected-generation must be a non-negative integer.");
  }
  return Number(value);
}

function roles(value) {
  const result = String(value || "").split(",").filter(Boolean);
  if (!result.length || result.some((role) => !INTEGRATION_WORKER_DIRECTORY_ROLES.includes(role))) {
    usage("--roles contains an unsupported role.");
  }
  return result;
}

async function openDirectory(command) {
  if (!PROBED_COMMANDS.has(command)) {
    return Object.freeze({
      directory: await createIntegrationWorkerDirectory({
        probe: async () => {
          throw new Error("worker probe is unavailable for this read-only command");
        },
      }),
      close() {},
    });
  }
  const authority = await createSystemdExecutionWorkerBindingAuthority();
  try {
    const directory = await createIntegrationWorkerDirectory({
      probe: (candidate) => authority.probe(candidate),
    });
    return Object.freeze({ directory, close: () => authority.close() });
  } catch (error) {
    authority.close();
    throw error;
  }
}

async function dispatch(parsed) {
  if (parsed.command === "help") return HELP;
  const opened = await openDirectory(parsed.command);
  const { directory } = opened;
  const options = parsed.options;
  try {
    switch (parsed.command) {
      case "status":
        return directory.status();
      case "events":
        return directory.events();
      case "resolve":
        return directory.resolve(options.role);
      case "enroll":
        return directory.enroll({
          nodeId: options["node-id"],
          bindingId: options["binding-id"],
          platform: options.platform,
          roles: roles(options.roles),
        });
      case "renew":
        return directory.renew(options["node-id"]);
      case "switch":
        return directory.switchRole(options.role, options["node-id"], {
          expectedGeneration: generation(options["expected-generation"]),
        });
      case "rollback":
        return directory.rollbackRole(options.role, {
          expectedGeneration: generation(options["expected-generation"]),
        });
      case "finalize":
        return directory.finalizeRole(options.role, {
          expectedGeneration: generation(options["expected-generation"]),
        });
      case "retire":
        return directory.retire(options["node-id"]);
      case "remove":
        return directory.remove(options["node-id"]);
      default:
        usage("Unsupported command.");
    }
  } finally {
    opened.close();
  }
}

try {
  const parsed = parse(process.argv.slice(2));
  const result = await dispatch(parsed);
  process.stdout.write(typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: error?.code || "WORKER_DIRECTORY_CLI_FAILED",
      message: error?.message || "Worker directory command failed.",
    },
  })}\n`);
  process.exitCode = 1;
}
