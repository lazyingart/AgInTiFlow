#!/usr/bin/env node
process.stdout.write(JSON.stringify({ temporaryConfig: process.env.NPM_CONFIG_USERCONFIG }) + "\n", () => {
  if (process.env.AGINTI_TEST_NPM_SIGNAL === "SIGTERM") process.kill(process.pid, "SIGTERM");
  else process.exit(Number(process.env.AGINTI_TEST_NPM_EXIT || 0));
});
