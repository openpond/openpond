#!/usr/bin/env node
import { buildCommand } from "./commands/build";
import { evalCommand } from "./commands/eval";
import { inspectCommand } from "./commands/inspect";
import { initCommand } from "./commands/init";
import { runCommand } from "./commands/run";
import { tracesCommand } from "./commands/traces";
import { validateCommand } from "./commands/validate";
import { parseArgs } from "./cli/args";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const options = await parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "inspect":
      await inspectCommand(options);
      return;
    case "init":
      await initCommand(options);
      return;
    case "build":
      await buildCommand(options);
      return;
    case "validate":
      await validateCommand(options);
      return;
    case "eval":
      await evalCommand(options);
      return;
    case "run":
      await runCommand(options);
      return;
    case "traces":
      await tracesCommand(options);
      return;
    case "help":
    default:
      printHelp();
  }
}

function printHelp() {
  console.log(`openpond-agent

Usage:
  openpond-agent inspect --json [--cwd <project>] [--out-dir <dir>]
  openpond-agent init [blank-agent|customer-reply-agent|integration-heavy-agent] [--cwd <dir>] [--force]
  openpond-agent build [--cwd <project>] [--out-dir <dir>]
  openpond-agent validate [--json] [--cwd <project>] [--out-dir <dir>]
  openpond-agent eval [--json] [--cwd <project>] [--out-dir <dir>]
  openpond-agent run <action> [--json] [--input <json>] [--cwd <project>] [--out-dir <dir>]
  openpond-agent traces [--json] [--cwd <project>] [--out-dir <dir>]

Machine-readable commands:
  inspect --json  writes .openpond/agent-inspect.json and prints inspect JSON
  validate --json writes .openpond/validator-report.md and prints validation JSON
  eval --json     writes .openpond/eval-results.json, traces, artifact-index.json, and prints eval JSON
  run --json      writes traces, artifact-index.json, and prints the action result JSON
  traces --json   prints trace artifact listings

Exit codes:
  nonzero means invalid args, source load failure, validation error, eval failure, or runtime failure.
  See docs/cli-machine-output.md for stable JSON fields, artifact paths, and downstream consumers.
`);
}
