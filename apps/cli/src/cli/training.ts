import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import {
  optionString,
  parseBooleanOption,
  parseIntegerOption,
  parseNumberOption,
} from "./common/options";
import { resolveApiBaseUrlOption } from "./common/urls";

const DEFAULT_LOCAL_TRAINING_API_URL = "http://127.0.0.1:17874";
const TERMINAL_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "succeeded",
]);

export type TrainingCommandDependencies = {
  request?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  confirm?: (message: string) => Promise<boolean>;
};

export async function runTrainingCommand(
  options: Record<string, string | boolean>,
  rest: string[],
  dependencies: TrainingCommandDependencies = {},
): Promise<void> {
  const subcommand = rest[0];
  const id = rest[1];
  if (
    !subcommand ||
    !["start", "status", "watch", "logs", "cancel", "artifacts"].includes(
      subcommand,
    ) ||
    !id
  ) {
    throw new Error(
      "usage: training <start|status|watch|logs|cancel|artifacts> <model-run-id|run-id>",
    );
  }
  if (rest.length > 2) {
    throw new Error(`training ${subcommand} accepts exactly one identifier`);
  }

  const client = new TrainingApiClient({
    baseUrl:
      resolveApiBaseUrlOption(options) ??
      process.env.OPENPOND_LOCAL_API_URL?.replace(/\/$/, "") ??
      DEFAULT_LOCAL_TRAINING_API_URL,
    request: dependencies.request,
  });
  const json = parseBooleanOption(options.json);

  if (subcommand === "start") {
    await startTraining({
      client,
      dependencies,
      json,
      modelRunId: id,
      options,
    });
    return;
  }
  if (subcommand === "watch") {
    await watchTraining({
      client,
      runId: id,
      json,
      intervalMs:
        parseIntegerOption(options.intervalMs, "interval-ms") ?? 2_000,
      sleep: dependencies.sleep,
    });
    return;
  }

  const endpoint = subcommand === "status"
    ? "status"
    : subcommand === "logs"
      ? "logs"
      : subcommand === "artifacts"
        ? "artifacts"
        : "cancel";
  const result = await client.modelRun(
    id,
    endpoint,
    subcommand === "cancel" ? "POST" : "GET",
  );
  printResult(result, json);
}

export class TrainingApiClient {
  readonly baseUrl: string;
  readonly request: typeof fetch;

  constructor(input: { baseUrl: string; request?: typeof fetch }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.request = input.request ?? fetch;
  }

  modelRun(
    id: string,
    action: "prepare" | "start" | "status" | "logs" | "artifacts" | "cancel",
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    return this.json(
      `/v1/training/model-runs/${encodeURIComponent(id)}/${action}`,
      method,
      body,
    );
  }

  private async json(
    pathname: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.request(`${this.baseUrl}${pathname}`, {
      method,
      headers: body === undefined
        ? { Accept: "application/json" }
        : {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `${response.status} ${response.statusText}`.trim();
      throw new Error(`Training API request failed: ${message}`);
    }
    return payload;
  }
}

async function startTraining(input: {
  client: TrainingApiClient;
  dependencies: TrainingCommandDependencies;
  json: boolean;
  modelRunId: string;
  options: Record<string, string | boolean>;
}): Promise<void> {
  const maximumSpendUsd = parseNumberOption(
    input.options.maxSpend,
    "max-spend",
  ) ?? null;
  if (maximumSpendUsd !== null && maximumSpendUsd < 0) {
    throw new Error("max-spend must be non-negative");
  }
  const retentionDays =
    parseIntegerOption(input.options.retentionDays, "retention-days") ?? null;
  if (retentionDays !== null && retentionDays <= 0) {
    throw new Error("retention-days must be a positive integer");
  }
  const manifestPath = optionString(input.options, "manifest");
  const manifest = manifestPath
    ? await readManifest(manifestPath)
    : undefined;
  const controls = { maximumSpendUsd, retentionDays };
  const preparation = await input.client.modelRun(
    input.modelRunId,
    "prepare",
    "POST",
    controls,
  );
  if (!input.json) {
    console.log("Preparation:");
    console.log(JSON.stringify(preparation, null, 2));
  }

  const confirmed = parseBooleanOption(input.options.yes) ||
    await confirmStart(input.dependencies.confirm);
  if (!confirmed) {
    throw new Error("Training start cancelled.");
  }
  const result = await input.client.modelRun(
    input.modelRunId,
    "start",
    "POST",
    { ...controls, manifest },
  );
  printResult(result, input.json);
  if (parseBooleanOption(input.options.detach)) return;

  const runId = readRunId(result) ?? input.modelRunId;
  await watchTraining({
    client: input.client,
    runId,
    json: input.json,
    intervalMs: 2_000,
    sleep: input.dependencies.sleep,
  });
}

async function watchTraining(input: {
  client: TrainingApiClient;
  runId: string;
  json: boolean;
  intervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  if (input.intervalMs < 250) {
    throw new Error("interval-ms must be at least 250");
  }
  const sleep = input.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let previous = "";
  for (;;) {
    const status = await input.client.modelRun(
      input.runId,
      "status",
      "GET",
    );
    const serialized = JSON.stringify(status);
    if (input.json || serialized !== previous) {
      printResult(status, input.json);
      previous = serialized;
    }
    if (TERMINAL_STATUSES.has(readStatus(status))) return;
    await sleep(input.intervalMs);
  }
}

async function readManifest(path: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read Harness Run Manifest ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Harness Run Manifest must be a JSON object.");
  }
  return parsed;
}

async function confirmStart(
  injected?: (message: string) => Promise<boolean>,
): Promise<boolean> {
  const message =
    "Start this exact prepared training run? Downloads, provisioning, or spend may begin.";
  if (injected) return injected(message);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "training start requires --yes when standard input is not interactive",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y" ||
      answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

function readRunId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const job = "job" in value ? value.job : null;
  if (!job || typeof job !== "object" || !("id" in job)) return null;
  return typeof job.id === "string" ? job.id : null;
}

function readStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if ("state" in value && typeof value.state === "string") {
    return value.state;
  }
  return "status" in value && typeof value.status === "string"
    ? value.status
    : "";
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}
