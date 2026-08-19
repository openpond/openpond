import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_SERVER_URL = "http://127.0.0.1:17914";
const DEFAULT_INTERVAL_MS = 5_000;

type EvaluationAttempt = {
  attemptId: string;
  phase: string;
  taskId: string;
  passed: boolean;
  score: number | null;
  failureClass: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number | null;
};

type EvaluationProgress = {
  stage: string;
  completedAttempts: number;
  totalAttempts: number;
  accounting: {
    observedSpendUsd: number;
    attempts: EvaluationAttempt[];
  } | null;
};

type ModelRun = {
  id: string;
  status: "prepared" | "running" | "succeeded" | "failed" | "cancelled";
  updatedAt: string;
  evaluationProgress: EvaluationProgress | null;
  reward: {
    raw: number;
    components: Record<string, number>;
  } | null;
  receipt: unknown;
  failure: string | null;
};

type ModelRunStatus = {
  runId: string;
  state: ModelRun["status"];
  updatedAt: string;
  evaluationProgress: EvaluationProgress | null;
  reward: ModelRun["reward"];
  receipt: unknown;
  failure: string | null;
};

type Options = {
  runId: string;
  serverUrl: string;
  intervalMs: number;
  once: boolean;
};

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  let serverUrl = process.env.OPENPOND_SERVER_URL ?? DEFAULT_SERVER_URL;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let once = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--server-url") {
      serverUrl = argv[++index] ?? "";
    } else if (argument === "--interval-ms") {
      intervalMs = Number(argv[++index]);
    } else if (argument === "--once") {
      once = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  const runId = positional[0] ?? "";
  if (!runId) {
    throw new Error(
      "Usage: pnpm benchmark:harness-refiner:monitor -- <model-run-id> [--interval-ms 5000] [--once]",
    );
  }
  if (!serverUrl) {
    throw new Error("--server-url must not be empty.");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("--interval-ms must be an integer of at least 1000.");
  }

  return {
    runId,
    serverUrl: serverUrl.replace(/\/$/, ""),
    intervalMs,
    once,
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function usd(value: number | null): string {
  return value === null ? "unknown" : `$${value.toFixed(6)}`;
}

function compactFailure(value: string): string {
  if (/<!doctype\s+html|<html[\s>]/i.test(value)) {
    const title = value.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    return title?.split("|").at(-1)?.trim() || "HTML error response from host";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function compactReceipt(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const receipt = value as Record<string, unknown>;
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    benchmarkId: receipt.benchmarkId,
    terminalClassification: receipt.terminalClassification,
    quality: receipt.quality,
    budget: receipt.budget,
    resultManifest: receipt.resultManifest,
    contentHash: receipt.contentHash,
  });
}

function attemptLine(attempt: EvaluationAttempt): string {
  const score = attempt.score === null ? "n/a" : attempt.score.toFixed(3);
  const outcome = attempt.passed ? "PASS" : "FAIL";
  const failure = attempt.failureClass ? ` failure=${attempt.failureClass}` : "";
  return [
    `[${timestamp()}] ATTEMPT ${outcome}`,
    `phase=${attempt.phase}`,
    `task=${attempt.taskId}`,
    `score=${score}${failure}`,
    `tokens=${attempt.totalTokens} (${attempt.inputTokens}in/${attempt.outputTokens}out)`,
    `latency=${(attempt.latencyMs / 1_000).toFixed(1)}s`,
    `cost=${usd(attempt.costUsd)}`,
  ].join(" ");
}

function progressSignature(run: ModelRun): string {
  const progress = run.evaluationProgress;
  return JSON.stringify({
    status: run.status,
    stage: progress?.stage ?? null,
    completedAttempts: progress?.completedAttempts ?? null,
    totalAttempts: progress?.totalAttempts ?? null,
    observedSpendUsd: progress?.accounting?.observedSpendUsd ?? null,
    updatedAt: run.updatedAt,
  });
}

function progressLine(run: ModelRun): string {
  const progress = run.evaluationProgress;
  if (!progress) {
    return `[${timestamp()}] RUN status=${run.status} progress=unavailable updated=${run.updatedAt}`;
  }
  return [
    `[${timestamp()}] RUN status=${run.status}`,
    `stage=${progress.stage}`,
    `progress=${progress.completedAttempts}/${progress.totalAttempts}`,
    `spend=${usd(progress.accounting?.observedSpendUsd ?? null)}`,
    `updated=${run.updatedAt}`,
  ].join(" ");
}

async function loadToken(): Promise<string> {
  const explicitToken = process.env.OPENPOND_APP_TOKEN?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const appHome = process.env.OPENPOND_APP_HOME
    ? resolve(process.env.OPENPOND_APP_HOME)
    : resolve(homedir(), ".openpond", "openpond-app");
  const tokenPath = process.env.OPENPOND_APP_TOKEN_FILE
    ? resolve(process.env.OPENPOND_APP_TOKEN_FILE)
    : resolve(appHome, "token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) {
    throw new Error(`OpenPond token file is empty: ${tokenPath}`);
  }
  return token;
}

async function fetchRun(options: Options, token: string): Promise<ModelRun> {
  const response = await fetch(
    `${options.serverUrl}/v1/training/model-runs/${encodeURIComponent(options.runId)}/status`,
    {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Model Run status request failed: HTTP ${response.status}`);
  }

  const status = (await response.json()) as ModelRunStatus;
  if (status.runId !== options.runId) {
    throw new Error(`Model Run not found: ${options.runId}`);
  }
  return {
    id: status.runId,
    status: status.state,
    updatedAt: status.updatedAt,
    evaluationProgress: status.evaluationProgress,
    reward: status.reward,
    receipt: status.receipt,
    failure: status.failure,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const token = await loadToken();
  const observedAttemptIds = new Set<string>();
  let lastProgress = "";
  let consecutiveErrors = 0;

  console.log(
    `[${timestamp()}] Watching ${options.runId} at ${options.serverUrl} every ${options.intervalMs}ms`,
  );

  while (true) {
    try {
      const run = await fetchRun(options, token);
      consecutiveErrors = 0;

      const attempts = run.evaluationProgress?.accounting?.attempts ?? [];
      for (const attempt of attempts) {
        if (!observedAttemptIds.has(attempt.attemptId)) {
          observedAttemptIds.add(attempt.attemptId);
          console.log(attemptLine(attempt));
        }
      }

      const signature = progressSignature(run);
      if (signature !== lastProgress) {
        console.log(progressLine(run));
        lastProgress = signature;
      }

      if (["succeeded", "failed", "cancelled"].includes(run.status)) {
        console.log(
          `[${timestamp()}] TERMINAL status=${run.status} reward=${run.reward ? run.reward.raw : "n/a"}`,
        );
        if (run.failure) {
          console.log(`[${timestamp()}] FAILURE ${compactFailure(run.failure)}`);
        }
        if (run.reward) {
          console.log(`[${timestamp()}] REWARD_COMPONENTS ${JSON.stringify(run.reward.components)}`);
        }
        if (run.receipt) {
          console.log(`[${timestamp()}] RECEIPT ${compactReceipt(run.receipt)}`);
        }
        process.exitCode = run.status === "succeeded" ? 0 : 1;
        return;
      }

      if (options.once) {
        return;
      }
    } catch (error) {
      consecutiveErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${timestamp()}] POLL_ERROR count=${consecutiveErrors} ${message}`);
      if (options.once) {
        throw error;
      }
    }

    await delay(options.intervalMs);
  }
}

process.once("SIGINT", () => {
  console.log(`\n[${timestamp()}] Monitor stopped by SIGINT.`);
  process.exit(130);
});
process.once("SIGTERM", () => {
  console.log(`\n[${timestamp()}] Monitor stopped by SIGTERM.`);
  process.exit(143);
});

await main();
