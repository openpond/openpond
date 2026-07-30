import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { HarnessActionBinding } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const SCORER_SCRIPT =
  "const moduleValue=await import(process.argv[1]);" +
  "const decision=JSON.parse(Buffer.from(process.argv[2],'base64url').toString('utf8'));" +
  "const score=moduleValue.scoreBudgetDecision(decision);" +
  "process.stdout.write(JSON.stringify(score));";

export type ProfileAgentHarnessRuntime = ReturnType<
  typeof createProfileAgentHarnessRuntime
>;

export function createProfileAgentHarnessRuntime(input: {
  agentRoot: string;
  scorerModulePath: string;
  artifactRoot: string;
  agentCliPath?: string;
  nodePath?: string;
}) {
  const nodePath = input.nodePath ?? process.execPath;
  const agentCliPath =
    input.agentCliPath ??
    path.resolve(process.cwd(), "node_modules", ".bin", "openpond-agent");

  async function executeAction(action: {
    binding: HarnessActionBinding;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }) {
    const actionArtifactRoot = path.join(
      input.artifactRoot,
      "agent-actions",
      `${action.binding.actionId}-${contentHash(action.arguments).slice(0, 16)}`,
    );
    await mkdir(actionArtifactRoot, { recursive: true, mode: 0o700 });
    const result = await runBoundedProcess({
      command: agentCliPath,
      args: [
        "run",
        action.binding.actionId,
        "--json",
        "--cwd",
        input.agentRoot,
        "--out-dir",
        actionArtifactRoot,
        "--input",
        JSON.stringify(action.arguments),
      ],
      cwd: input.agentRoot,
      signal: action.signal,
    });
    const payload = object(JSON.parse(result.stdout), "Profile Agent result");
    const actionResult = object(payload.result, "Profile Agent action result");
    const output = object(
      JSON.parse(requiredString(actionResult.text, "Profile Agent action text")),
      "Profile Agent action output",
    );
    return {
      output,
      artifactRefs:
        typeof payload.traceArtifactRef === "string"
          ? [payload.traceArtifactRef]
          : [],
      terminal:
        action.binding.actionId === "submit-budget-decision" &&
        output.accepted === true,
    };
  }

  async function scoreDecision(decision: Record<string, unknown>) {
    const result = await runBoundedProcess({
      command: nodePath,
      args: [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        SCORER_SCRIPT,
        input.scorerModulePath,
        Buffer.from(JSON.stringify(decision), "utf8").toString("base64url"),
      ],
      cwd: process.cwd(),
    });
    const score = object(JSON.parse(result.stdout), "Portfolio scorer result");
    const components = object(score.components, "Portfolio score components");
    const validation = object(score.validation, "Portfolio score validation");
    return {
      reward: boundedScore(score.reward, "reward"),
      components: {
        constraints: boundedScore(components.constraints, "constraints"),
        portfolioValue: boundedScore(
          components.portfolioValue,
          "portfolioValue",
        ),
        riskControls: boundedScore(components.riskControls, "riskControls"),
        rationale: boundedScore(components.rationale, "rationale"),
      },
      validation: { accepted: validation.accepted === true },
    };
  }

  return { executeAction, scoreDecision };
}

async function runBoundedProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        fail(new Error(`${path.basename(input.command)} output exceeded its limit.`));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (settled) return;
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        fail(
          new Error(
            `${path.basename(input.command)} failed ${
              signal ? `with ${signal}` : `with exit code ${code}`
            }: ${err.slice(0, 2_000)}`,
          ),
        );
      } else {
        settled = true;
        resolve({ stdout: out, stderr: err });
      }
    });
    const abort = () => {
      child.kill("SIGTERM");
      fail(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new Error("Profile Agent process cancelled."),
      );
    };
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
  });
}

function boundedScore(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`Marketing portfolio ${label} score is invalid.`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
