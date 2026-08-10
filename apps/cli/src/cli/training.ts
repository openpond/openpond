import { readFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import os from "node:os";
import path from "node:path";
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
    ![
      "start",
      "status",
      "watch",
      "logs",
      "cancel",
      "artifacts",
      "benchmark",
    ].includes(
      subcommand,
    ) ||
    !id
  ) {
    throw new Error(
      "usage: training <start|status|watch|logs|cancel|artifacts|benchmark> <model-run-id|run-id|model-id>",
    );
  }
  if (rest.length > 2) {
    throw new Error(`training ${subcommand} accepts exactly one identifier`);
  }

  const baseUrl =
    resolveApiBaseUrlOption(options) ??
    process.env.OPENPOND_LOCAL_API_URL?.replace(/\/$/, "") ??
    DEFAULT_LOCAL_TRAINING_API_URL;
  const client = new TrainingApiClient({
    baseUrl,
    request:
      dependencies.request ??
      await createLocalAuthenticatedRequest(baseUrl),
  });
  const json = parseBooleanOption(options.json);

  if (subcommand === "benchmark") {
    await startHarnessRefinerBenchmark({
      client,
      modelId: id,
      options,
      json,
      sleep: dependencies.sleep,
    });
    return;
  }

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

async function createLocalAuthenticatedRequest(
  baseUrl: string,
): Promise<typeof fetch> {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    return fetch;
  }
  const appHome =
    process.env.OPENPOND_APP_HOME?.trim()
    || path.join(os.homedir(), ".openpond", "openpond-app");
  const token = (await readFile(path.join(appHome, "token"), "utf8")).trim();
  if (!token) {
    throw new Error("OpenPond local capability token is empty.");
  }
  return (async (
    resource: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const target =
      resource instanceof Request
        ? new URL(resource.url)
        : new URL(String(resource));
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const nodeHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      nodeHeaders[name] = value;
    });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request = requestHttp(
        target,
        {
          method: init.method ?? "GET",
          headers: nodeHeaders,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", rejectOnce);
          response.once("end", () => {
            if (settled) return;
            settled = true;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) responseHeaders.append(name, item);
              } else if (value !== undefined) {
                responseHeaders.set(name, value);
              }
            }
            resolve(
              new Response(new Uint8Array(Buffer.concat(chunks)), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.once("error", rejectOnce);
      if (init.signal) {
        const abort = () =>
          request.destroy(
            init.signal?.reason instanceof Error
              ? init.signal.reason
              : new Error("Training API request aborted."),
          );
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      }
      if (init.body !== undefined && init.body !== null) {
        if (
          typeof init.body !== "string"
          && !(init.body instanceof Uint8Array)
        ) {
          request.destroy(
            new Error("Local Training API supports string or byte request bodies."),
          );
          return;
        }
        request.write(init.body);
      }
      request.end();
    });
  }) as typeof fetch;
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

  trainingState(): Promise<unknown> {
    return this.json("/v1/training", "GET");
  }

  startHarnessRefinerBenchmark(modelId: string, body: unknown): Promise<unknown> {
    return this.json(
      `/v1/training/models/${encodeURIComponent(modelId)}/harness-refiner-benchmark`,
      "POST",
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

async function startHarnessRefinerBenchmark(input: {
  client: TrainingApiClient;
  modelId: string;
  options: Record<string, string | boolean>;
  json: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const state = await input.client.trainingState();
  const project = modelProject(state, input.modelId);
  const providerId = optionString(input.options, "provider") ?? "openpond";
  const modelId = optionString(input.options, "model") ?? "openpond-chat";
  const effort = optionString(input.options, "reasoningEffort") ?? "high";
  const mode = optionString(input.options, "mode") === "smoke" ? "smoke" : "full";
  const seed = parseIntegerOption(input.options.seed, "seed") ?? 17;
  const repetitions = parseIntegerOption(input.options.repetitions, "repetitions") ?? 1;
  if (repetitions < 1 || repetitions > 20) {
    throw new Error("repetitions must be between 1 and 20");
  }
  const maximumSpendUsd = parseNumberOption(input.options.maxSpend, "max-spend") ?? 0;
  if (maximumSpendUsd < 0) throw new Error("max-spend must be non-negative");
  const run = await input.client.startHarnessRefinerBenchmark(input.modelId, {
    profileId: project.profileId,
    model: { providerId, modelId },
    reasoningEffort: effort === "none" ? "none" : effort,
    mode,
    seeds: [seed],
    repetitions,
    maximumSpendUsd,
  });
  printResult(run, input.json);
  if (parseBooleanOption(input.options.detach)) return;
  const runId = objectString(run, "id");
  if (!runId) throw new Error("Benchmark start did not return a Model Run id.");
  await watchTraining({
    client: input.client,
    runId,
    json: input.json,
    intervalMs: parseIntegerOption(input.options.intervalMs, "interval-ms") ?? 2_000,
    sleep: input.sleep,
  });
}

function modelProject(value: unknown, modelId: string): { profileId: string } {
  if (!value || typeof value !== "object" || !("modelProjects" in value)) {
    throw new Error("Training state did not include Models.");
  }
  const projects = Array.isArray(value.modelProjects) ? value.modelProjects : [];
  const project = projects.find(
    (candidate) =>
      candidate
      && typeof candidate === "object"
      && "id" in candidate
      && candidate.id === modelId,
  );
  const profileId = project && typeof project === "object"
    ? objectString(project, "profileId")
    : null;
  if (!profileId) throw new Error(`Model ${modelId} was not found.`);
  return { profileId };
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate ? candidate : null;
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
