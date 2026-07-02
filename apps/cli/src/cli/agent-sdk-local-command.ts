import path from "node:path";

import {
  optionString,
  parseBooleanOption,
  runCommand,
} from "./common";
import { resolveLocalAgentSdkCommand } from "./agent-sdk-command";

const LOCAL_AGENT_SDK_COMMANDS = new Set([
  "inspect",
  "build",
  "validate",
  "eval",
  "traces",
]);

export function shouldDelegateLocalAgentSdkCommand(
  subcommand: string,
  options: Record<string, string | boolean>
): boolean {
  if (LOCAL_AGENT_SDK_COMMANDS.has(subcommand)) return true;
  return subcommand === "run" && !optionString(options, "teamId");
}

export async function runLocalAgentSdkCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "inspect";
  const cwd = path.resolve(
    optionString(options, "cwd") || optionString(options, "path") || "."
  );
  const args = [subcommand, ...rest.slice(1), "--cwd", cwd];
  if (parseBooleanOption(options.json)) args.push("--json");
  appendForwardedOption(args, options, "input", "input");
  appendForwardedOption(args, options, "inputFile", "input-file");

  const command = resolveLocalAgentSdkCommand(cwd);
  const result = await runCommand(command.command, [...command.args, ...args], {
    cwd,
    inherit: true,
  });
  if (result.code !== 0) process.exitCode = result.code ?? 1;
}

function appendForwardedOption(
  args: string[],
  options: Record<string, string | boolean>,
  optionKey: string,
  cliName: string
): void {
  const value = optionString(options, optionKey);
  if (value) args.push(`--${cliName}`, value);
}
