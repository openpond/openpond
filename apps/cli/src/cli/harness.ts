import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { runProcessCommand } from "../process-runner";
import { CliUsageError, optionString, parseBooleanOption } from "./common";

const DESKTOP_HARNESS_SCRIPT = path.join("scripts", "desktop-harness.ts");

type HarnessCommandOptions = Record<string, string | boolean>;

export type DesktopHarnessCliInvocation = {
  command: string;
  args: string[];
  cwd: string;
};

export async function runHarnessCommand(
  options: HarnessCommandOptions,
  rest: string[]
): Promise<void> {
  const invocation = await buildDesktopHarnessInvocation({ options, rest });
  const result = await runProcessCommand(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    inherit: true,
    timeoutMs: 0,
  });
  if (result.code !== 0) {
    throw new HarnessCommandFailedError(result.code);
  }
}

export async function buildDesktopHarnessInvocation(input: {
  options: HarnessCommandOptions;
  rest: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<DesktopHarnessCliInvocation> {
  const options = input.options;
  const rest = input.rest;
  const surface = rest[0];
  const action = rest[1];
  if (surface !== "desktop" || (action !== "run" && action !== "attach")) {
    throw new CliUsageError(desktopHarnessCliUsage());
  }

  const scenarios = rest.slice(2);
  if (scenarios.length === 0) {
    throw new CliUsageError("usage: openpond harness desktop run <scenario...> [options]");
  }

  const startCwd = optionString(options, "cwd") || input.cwd || process.cwd();
  const repoRoot = await resolveDesktopHarnessRepoRoot(startCwd);
  const env = input.env ?? process.env;
  const command = env.BUN_BINARY?.trim() || "bun";
  const args = [DESKTOP_HARNESS_SCRIPT, "run", ...scenarios];

  const launchMode = resolveLaunchMode(options, action);
  if (launchMode) args.push(`--${launchMode}`);

  appendStringFlag(args, "--app", options, "app");
  appendStringFlag(args, "--server", options, "server");
  appendStringFlag(args, "--token", options, "token");
  appendStringFlag(args, "--token-file", options, "tokenFile");
  appendStringFlag(args, "--devtools-port", options, "devtoolsPort");
  appendStringFlag(args, "--artifacts-dir", options, "artifactsDir");
  appendJsonFlag(args, options);
  appendStringFlag(args, "--grep", options, "grep");
  appendStringFlag(args, "--timeout-ms", options, "timeoutMs");
  if (parseBooleanOption(options.keepHome)) args.push("--keep-home");

  return { command, args, cwd: repoRoot };
}

export async function resolveDesktopHarnessRepoRoot(startCwd: string): Promise<string> {
  let current = path.resolve(startCwd);
  while (true) {
    const scriptPath = path.join(current, DESKTOP_HARNESS_SCRIPT);
    if (await fileExists(scriptPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new CliUsageError(
        `Could not find ${DESKTOP_HARNESS_SCRIPT}. Run this command from the OpenPond source checkout or pass --cwd <repo>.`
      );
    }
    current = parent;
  }
}

function resolveLaunchMode(
  options: HarnessCommandOptions,
  action: string
): "isolated" | "attach" | "packaged" | "none" | null {
  let mode: "isolated" | "attach" | "packaged" | "none" | null = action === "attach" ? "attach" : null;
  for (const candidate of ["isolated", "attach", "packaged", "none"] as const) {
    if (!parseBooleanOption(options[candidate])) continue;
    if (mode && mode !== candidate) {
      throw new CliUsageError("Choose only one desktop harness launch mode: --isolated, --attach, --packaged, or --none.");
    }
    mode = candidate;
  }
  return mode;
}

function appendStringFlag(
  args: string[],
  flag: string,
  options: HarnessCommandOptions,
  key: string
): void {
  const value = optionString(options, key);
  if (!value) return;
  args.push(flag, value);
}

function appendJsonFlag(args: string[], options: HarnessCommandOptions): void {
  const json = optionString(options, "json");
  const jsonPath = optionString(options, "jsonPath");
  if (json && isBooleanLiteral(json)) {
    throw new CliUsageError("harness --json requires a report path. Use --json <path> or --json-path <path>.");
  }
  if (json && jsonPath && json !== jsonPath) {
    throw new CliUsageError("Use only one JSON report path: --json <path> or --json-path <path>.");
  }
  const value = json || jsonPath;
  if (value) args.push("--json", value);
}

function isBooleanLiteral(value: string): boolean {
  return /^(true|false|1|0|yes|no)$/i.test(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function desktopHarnessCliUsage(): string {
  return [
    "usage: openpond harness desktop run <scenario...> [options]",
    "       openpond harness desktop attach <scenario...> [options]",
    "",
    "Options include --isolated, --attach, --packaged, --none, --app <path>,",
    "--server <url>, --token <token>, --token-file <path>, --devtools-port <port>, --artifacts-dir <path>,",
    "--json <path>, --json-path <path>, --grep <pattern>, --timeout-ms <ms>,",
    "--keep-home, and --cwd <repo>.",
  ].join("\n");
}

class HarnessCommandFailedError extends Error {
  readonly exitCode: number;

  constructor(code: number | null) {
    const exitCode = typeof code === "number" && code > 0 ? code : 1;
    super(`desktop harness failed with exit code ${exitCode}`);
    this.name = "HarnessCommandFailedError";
    this.exitCode = exitCode;
  }
}
