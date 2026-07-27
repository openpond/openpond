import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { HarnessActionBinding } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type {
  MarketingPortfolioActionRunner,
} from "./marketing-portfolio-rollout.js";

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const SCORER_SCRIPT =
  "const moduleValue=await import(process.argv[1]);"
  + "const decision=JSON.parse(Buffer.from(process.argv[2],'base64url').toString('utf8'));"
  + "const score=moduleValue.scoreBudgetDecision(decision);"
  + "process.stdout.write(JSON.stringify(score));";

export function createProfileAgentHarnessRuntime(input: {
  agentRoot: string;
  scorerModulePath: string;
  artifactRoot: string;
  agentCliPath?: string;
  nodePath?: string;
}) {
  const nodePath = input.nodePath ?? process.execPath;
  const agentCliPath =
    input.agentCliPath
    ?? path.resolve(process.cwd(), "node_modules", ".bin", "openpond-agent");

  const executeAction: MarketingPortfolioActionRunner = async ({
    binding,
    arguments: actionInput,
    signal,
  }) => {
    const actionArtifactRoot = path.join(
      input.artifactRoot,
      "agent-actions",
      `${binding.actionId}-${contentHash(actionInput).slice(0, 16)}`,
    );
    await mkdir(actionArtifactRoot, { recursive: true, mode: 0o700 });
    const result = await runBoundedProcess({
      command: agentCliPath,
      args: [
        "run",
        binding.actionId,
        "--json",
        "--cwd",
        input.agentRoot,
        "--out-dir",
        actionArtifactRoot,
        "--input",
        JSON.stringify(actionInput),
      ],
      cwd: input.agentRoot,
      signal,
    });
    const payload = object(
      JSON.parse(result.stdout),
      `Profile Agent ${binding.actionId} result`,
    );
    const actionResult = object(
      payload.result,
      `Profile Agent ${binding.actionId} action result`,
    );
    const output = parseAgentText(actionResult.text, binding);
    return {
      output,
      artifactRefs:
        typeof payload.traceArtifactRef === "string"
          ? [payload.traceArtifactRef]
          : [],
      terminal:
        binding.actionId === "submit-budget-decision"
        && output.accepted === true,
    };
  };

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
    const score = object(
      JSON.parse(result.stdout),
      "Marketing portfolio scorer result",
    );
    const components = object(
      score.components,
      "Marketing portfolio score components",
    );
    const validation = object(
      score.validation,
      "Marketing portfolio score validation",
    );
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
      validation: {
        accepted: validation.accepted === true,
      },
    };
  }

  return {
    executeAction,
    scoreDecision,
  };
}

function parseAgentText(
  value: unknown,
  binding: HarnessActionBinding,
): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Profile Agent ${binding.actionId} returned no text.`);
  }
  try {
    return object(
      JSON.parse(value),
      `Profile Agent ${binding.actionId} JSON output`,
    );
  } catch (error) {
    throw new Error(
      `Profile Agent ${binding.actionId} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
        return;
      }
      target.push(chunk);
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
        return;
      }
      settled = true;
      resolve({ stdout: out, stderr: err });
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
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
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
