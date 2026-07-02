import { existsSync } from "node:fs";
import { join } from "node:path";

import { runGoalShellCommand } from "./shell";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type { GoalCommandResult } from "../types";

export type AgentSdkCommand =
  | "inspect"
  | "build"
  | "validate"
  | "eval"
  | "traces"
  | "run";

export function resolveProjectLocalAgentCommand(cwd: string): {
  command: string;
  args: string[];
} | null {
  const packageDistCli = join(
    cwd,
    "node_modules",
    "openpond-agent-sdk",
    "dist",
    "cli.js"
  );
  if (existsSync(packageDistCli)) return { command: "bun", args: [packageDistCli] };

  const localBin = join(cwd, "node_modules", ".bin", "openpond-agent");
  if (existsSync(localBin)) return { command: localBin, args: [] };

  const packageCli = join(
    cwd,
    "node_modules",
    "openpond-agent-sdk",
    "src",
    "cli.ts"
  );
  if (existsSync(packageCli)) return { command: "bun", args: [packageCli] };

  return null;
}

export async function runAgentSdkCommand(params: {
  goalId: string;
  iterationId?: string | null;
  cwd: string;
  sdkCommand: AgentSdkCommand;
  args?: string[];
  json?: boolean;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalCommandResult> {
  if (
    params.sdkCommand === "inspect" &&
    !resolveProjectLocalAgentCommand(params.cwd) &&
    !existsSync(join(params.cwd, "package.json"))
  ) {
    return uninitializedAgentInspectResult(params.cwd);
  }

  const command = await ensureProjectLocalAgentCommand(params);
  const args = [
    ...command.args,
    params.sdkCommand,
    ...(params.args ?? []),
    "--cwd",
    params.cwd,
  ];
  if (params.json) args.push("--json");
  return runGoalShellCommand({
    goalId: params.goalId,
    iterationId: params.iterationId,
    command: [command.command, ...args].map(shellEscape).join(" "),
    cwd: params.cwd,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
}

function uninitializedAgentInspectResult(cwd: string): GoalCommandResult {
  const now = new Date().toISOString();
  return {
    command: "openpond-agent inspect --json",
    cwd,
    code: 0,
    timedOut: false,
    durationMs: 0,
    stdoutTail: JSON.stringify({
      status: "not_initialized",
      summary:
        "No OpenPond agent project was found yet. Create package.json and source files before running SDK validation.",
      packageJsonFound: false,
      projectLocalOpenpondAgentFound: false,
    }),
    stderrTail: "",
    artifactRefs: [],
    startedAt: now,
    completedAt: now,
  };
}

export async function runDefaultAgentSdkChecks(params: {
  goalId: string;
  iterationId: string;
  cwd: string;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalCommandResult[]> {
  const commands: AgentSdkCommand[] = [
    "inspect",
    "build",
    "validate",
    "eval",
    "traces",
  ];
  const results: GoalCommandResult[] = [];
  for (const sdkCommand of commands) {
    const result = await runAgentSdkCommand({
      ...params,
      sdkCommand,
      json:
        sdkCommand === "inspect" ||
        sdkCommand === "eval" ||
        sdkCommand === "traces",
    });
    results.push(result);
    if (result.code !== 0 || result.timedOut) break;
  }
  return results;
}

async function ensureProjectLocalAgentCommand(params: {
  goalId: string;
  iterationId?: string | null;
  cwd: string;
  workspace?: string | null;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<{ command: string; args: string[] }> {
  const existing = resolveProjectLocalAgentCommand(params.cwd);
  if (existing) return existing;

  const installCommand = dependencyInstallCommand(params.cwd);
  if (!installCommand) {
    throw new Error(
      "project-local openpond-agent is missing and no package.json was found"
    );
  }

  const setup = await runGoalShellCommand({
    goalId: params.goalId,
    iterationId: params.iterationId,
    command: installCommand,
    cwd: params.cwd,
    timeoutSeconds: 600,
    workspace: params.workspace,
    storageRoot: params.storageRoot,
    localState: params.localState,
    hostedClient: params.hostedClient,
  });
  if (setup.code !== 0 || setup.timedOut) {
    throw new Error(`dependency setup failed before openpond-agent: ${installCommand}`);
  }

  const installed = resolveProjectLocalAgentCommand(params.cwd);
  if (!installed) {
    throw new Error("project-local openpond-agent was not created by dependency setup");
  }
  return installed;
}

function dependencyInstallCommand(cwd: string): string | null {
  if (!existsSync(join(cwd, "package.json"))) return null;
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm install";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn install";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm install";
  return "bun install";
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
