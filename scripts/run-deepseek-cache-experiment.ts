import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadOpenPondAccountContext } from "../packages/runtime/src/account-context.js";
import { normalizeModelUsageTokens } from "../apps/server/src/runtime/model-usage-normalization.js";

const MODEL = "accounts/fireworks/models/deepseek-v4-flash";
const DEFAULT_MAX_USD = 0.05;
const ABSOLUTE_MAX_USD = 2;
const DEFAULT_PAUSE_MS = 2_500;
const MAX_OUTPUT_TOKENS = 64;

type Pricing = {
  version: string;
  source: string;
  effectiveAt: string;
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

type ExperimentCase = {
  label: string;
  cohort: "prefix" | "affinity" | "tools";
  body: Record<string, unknown>;
  affinityKey?: string;
};

type Observation = {
  label: string;
  cohort: ExperimentCase["cohort"];
  status: number;
  elapsedMs: number;
  finishReason: string | null;
  outputMatched: boolean;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  uncachedPromptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheTelemetrySource: string | null;
  cacheHitRate: number | null;
  costUsd: number | null;
  cacheHeaders: Record<string, string>;
};

type Options = {
  maxUsd: number;
  pauseMs: number;
  outputPath: string;
};

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseOptions(process.argv.slice(2), root);
  const context = await loadOpenPondAccountContext();
  if (!context.token) throw new Error("No OpenPond account token is configured.");

  const apiBaseUrl = context.chatApiBaseUrl.replace(/\/+$/, "");
  const pricing = await loadPricing(apiBaseUrl, context.token);
  const cases = experimentCases();
  const projectedMaximumCostUsd = projectedMaximumCost(cases, pricing);
  if (projectedMaximumCostUsd > options.maxUsd) {
    throw new Error(
      `Projected worst-case cost $${projectedMaximumCostUsd.toFixed(6)} exceeds the configured $${options.maxUsd.toFixed(2)} ceiling.`,
    );
  }

  const observations: Observation[] = [];
  for (const [index, experimentCase] of cases.entries()) {
    const observation = await runCase({
      apiBaseUrl,
      token: context.token,
      pricing,
      experimentCase,
    });
    observations.push(observation);
    const observedCostUsd = observations.reduce(
      (total, row) => total + (row.costUsd ?? 0),
      0,
    );
    if (observedCostUsd > options.maxUsd) {
      throw new Error(
        `Observed experiment cost $${observedCostUsd.toFixed(6)} exceeded the configured ceiling.`,
      );
    }
    process.stderr.write(
      `${observation.label}: cache=${formatRate(observation.cacheHitRate)} elapsed=${observation.elapsedMs}ms cost=${formatUsd(observation.costUsd)}\n`,
    );
    if (index < cases.length - 1 && options.pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
    }
  }

  const report = {
    schemaVersion: "openpond.deepseekCacheExperiment.v1",
    generatedAt: new Date().toISOString(),
    apiHost: new URL(apiBaseUrl).host,
    model: MODEL,
    pricing,
    configuredMaxUsd: options.maxUsd,
    projectedMaximumCostUsd,
    observedCostUsd: observations.reduce((total, row) => total + (row.costUsd ?? 0), 0),
    telemetryCoverage: ratio(
      observations.filter((row) => row.cacheHitRate !== null).length,
      observations.length,
    ),
    tokenWeightedCacheHitRate: ratio(
      observations.reduce((total, row) => total + (row.cachedPromptTokens ?? 0), 0),
      observations.reduce(
        (total, row) => total + (row.cachedPromptTokens ?? 0) + (row.uncachedPromptTokens ?? 0),
        0,
      ),
    ),
    contrasts: contrasts(observations),
    observations,
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: options.outputPath }, null, 2)}\n`);
}

function experimentCases(): ExperimentCase[] {
  const runNonce = randomUUID();
  const stableSystem = syntheticPrefix("STABLE", runNonce);
  const mutatedSystem = syntheticPrefix("MUTATED", runNonce);
  const alphaAffinity = `openpond-cache-alpha-${randomUUID()}`;
  const betaAffinity = `openpond-cache-beta-${randomUUID()}`;
  const baseBody = (system: string, suffix: string): Record<string, unknown> => ({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `${suffix}\nReply with exactly CACHE-EXPERIMENT-OK.`,
      },
    ],
    thinking: { type: "disabled" },
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
    metadata: { source: "openpond-cache-experiment" },
  });
  const exactBody = baseBody(stableSystem, "PREFIX-CONTROL-A");
  const affinityBody = baseBody(stableSystem, "AFFINITY-CONTROL");
  const tools = toolSchemas();
  const toolBody = {
    ...baseBody(stableSystem, "TOOL-ORDER-CONTROL"),
    tools,
    tool_choice: "auto",
  };

  return [
    { label: "prefix_warm", cohort: "prefix", body: exactBody },
    { label: "prefix_exact_repeat", cohort: "prefix", body: structuredClone(exactBody) },
    {
      label: "prefix_early_mutation",
      cohort: "prefix",
      body: baseBody(mutatedSystem, "PREFIX-CONTROL-A"),
    },
    {
      label: "prefix_common_variant_b",
      cohort: "prefix",
      body: baseBody(stableSystem, "PREFIX-CONTROL-B"),
    },
    {
      label: "prefix_common_variant_c",
      cohort: "prefix",
      body: baseBody(stableSystem, "PREFIX-CONTROL-C"),
    },
    {
      label: "affinity_alpha_warm",
      cohort: "affinity",
      body: affinityBody,
      affinityKey: alphaAffinity,
    },
    {
      label: "affinity_alpha_repeat",
      cohort: "affinity",
      body: structuredClone(affinityBody),
      affinityKey: alphaAffinity,
    },
    {
      label: "affinity_beta_same_prompt",
      cohort: "affinity",
      body: structuredClone(affinityBody),
      affinityKey: betaAffinity,
    },
    { label: "tools_order_a_warm", cohort: "tools", body: toolBody },
    {
      label: "tools_order_a_repeat",
      cohort: "tools",
      body: structuredClone(toolBody),
    },
    {
      label: "tools_order_b_reversed",
      cohort: "tools",
      body: { ...structuredClone(toolBody), tools: [...tools].reverse() },
    },
  ];
}

function syntheticPrefix(
  firstLine: "STABLE" | "MUTATED",
  runNonce: string,
): string {
  return Array.from({ length: 96 }, (_, index) => {
    const marker = index === 0 ? firstLine : "STABLE";
    return `CACHE-${marker}-${String(index).padStart(3, "0")}-${runNonce}: deterministic synthetic OpenPond context with no user or repository data.`;
  }).join("\n");
}

function toolSchemas(): Array<Record<string, unknown>> {
  return [
    {
      type: "function",
      function: {
        name: "lookup_cache_fixture",
        description: "Read one deterministic synthetic cache fixture.",
        parameters: {
          type: "object",
          properties: { fixtureId: { type: "string" } },
          required: ["fixtureId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "summarize_cache_fixture",
        description: "Summarize one deterministic synthetic cache fixture.",
        parameters: {
          type: "object",
          properties: { fixtureId: { type: "string" } },
          required: ["fixtureId"],
        },
      },
    },
  ];
}

async function runCase(input: {
  apiBaseUrl: string;
  token: string;
  pricing: Pricing;
  experimentCase: ExperimentCase;
}): Promise<Observation> {
  const startedAt = performance.now();
  const response = await fetch(`${input.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-openpond-client": "openpond-cache-experiment",
      "x-openpond-request-id": randomUUID(),
      ...(input.experimentCase.affinityKey
        ? { "x-session-affinity": input.experimentCase.affinityKey }
        : {}),
    },
    body: JSON.stringify(input.experimentCase.body),
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `${input.experimentCase.label} failed: ${response.status} ${safeError(payload)}`,
    );
  }
  const usage = record(payload.usage);
  const normalized = normalizeModelUsageTokens(usage);
  const output = String(
    Array.isArray(payload.choices)
      ? record(record(payload.choices[0]).message).content ?? ""
      : "",
  ).trim();
  const promptDenominator = (
    normalized.cachedPromptTokens ?? 0
  ) + (
    normalized.uncachedPromptTokens ?? 0
  );

  return {
    label: input.experimentCase.label,
    cohort: input.experimentCase.cohort,
    status: response.status,
    elapsedMs,
    finishReason: stringOrNull(record(payload.choices?.[0]).finish_reason),
    outputMatched: output === "CACHE-EXPERIMENT-OK",
    promptTokens: normalized.promptTokens,
    cachedPromptTokens: normalized.cachedPromptTokens,
    uncachedPromptTokens: normalized.uncachedPromptTokens,
    completionTokens: normalized.completionTokens,
    totalTokens: normalized.totalTokens,
    cacheTelemetrySource: normalized.cacheTelemetrySource,
    cacheHitRate: promptDenominator > 0 && normalized.cachedPromptTokens !== null
      ? normalized.cachedPromptTokens / promptDenominator
      : null,
    costUsd: usageCost(normalized, input.pricing),
    cacheHeaders: Object.fromEntries(
      [...response.headers.entries()].filter(([name]) =>
        /cache|prompt-token|cached-token/i.test(name)
      ),
    ),
  };
}

async function loadPricing(apiBaseUrl: string, token: string): Promise<Pricing> {
  const response = await fetch(`${apiBaseUrl}/models/${encodeURIComponent(MODEL)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-openpond-client": "openpond-cache-experiment",
      "x-openpond-request-id": randomUUID(),
    },
  });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(`Model catalog request failed: ${response.status}`);
  const pricing = record(record(record(payload.metadata).billing).pricing);
  return {
    version: requiredString(pricing.version, "pricing version"),
    source: requiredString(pricing.source, "pricing source"),
    effectiveAt: requiredString(pricing.effectiveAt, "pricing effective date"),
    inputUsdPerMillionTokens: requiredNumber(
      pricing.inputUsdPerMillionTokens,
      "uncached input price",
    ),
    cachedInputUsdPerMillionTokens: requiredNumber(
      pricing.cachedInputUsdPerMillionTokens,
      "cached input price",
    ),
    outputUsdPerMillionTokens: requiredNumber(
      pricing.outputUsdPerMillionTokens,
      "output price",
    ),
  };
}

function projectedMaximumCost(cases: ExperimentCase[], pricing: Pricing): number {
  const conservativeInputTokens = cases.reduce(
    (total, row) => total + JSON.stringify(row.body).length,
    0,
  );
  const outputTokens = cases.length * MAX_OUTPUT_TOKENS;
  return (
    conservativeInputTokens * pricing.inputUsdPerMillionTokens
    + outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
}

function usageCost(
  usage: ReturnType<typeof normalizeModelUsageTokens>,
  pricing: Pricing,
): number | null {
  if (usage.promptTokens === null && usage.completionTokens === null) return null;
  return (
    (usage.uncachedPromptTokens ?? usage.promptTokens ?? 0)
      * pricing.inputUsdPerMillionTokens
    + (usage.cachedPromptTokens ?? 0) * pricing.cachedInputUsdPerMillionTokens
    + (usage.completionTokens ?? 0) * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
}

function contrasts(rows: Observation[]) {
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  const rate = (label: string) => byLabel.get(label)?.cacheHitRate ?? null;
  return {
    exactRepeatMinusWarm: difference(rate("prefix_exact_repeat"), rate("prefix_warm")),
    commonVariantCMinusB: difference(
      rate("prefix_common_variant_c"),
      rate("prefix_common_variant_b"),
    ),
    affinityRepeatMinusWarm: difference(
      rate("affinity_alpha_repeat"),
      rate("affinity_alpha_warm"),
    ),
    changedAffinityMinusStableRepeat: difference(
      rate("affinity_beta_same_prompt"),
      rate("affinity_alpha_repeat"),
    ),
    stableToolOrderMinusWarm: difference(
      rate("tools_order_a_repeat"),
      rate("tools_order_a_warm"),
    ),
    reversedToolOrderMinusStableRepeat: difference(
      rate("tools_order_b_reversed"),
      rate("tools_order_a_repeat"),
    ),
  };
}

function parseOptions(args: string[], root: string): Options {
  const maxUsd = numberOption(args, "--max-usd") ?? DEFAULT_MAX_USD;
  if (maxUsd <= 0 || maxUsd > ABSOLUTE_MAX_USD) {
    throw new Error(`--max-usd must be greater than 0 and at most ${ABSOLUTE_MAX_USD}.`);
  }
  const pauseMs = numberOption(args, "--pause-ms") ?? DEFAULT_PAUSE_MS;
  if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 30_000) {
    throw new Error("--pause-ms must be an integer from 0 through 30000.");
  }
  const output = stringOption(args, "--output") ?? path.join(
    root,
    "tmp",
    "cache-telemetry",
    `deepseek-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  return { maxUsd, pauseMs, outputPath: path.resolve(root, output) };
}

function numberOption(args: string[], name: string): number | null {
  const value = stringOption(args, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function stringOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return record(JSON.parse(text));
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function safeError(payload: Record<string, unknown>): string {
  const message = payload.detail ?? payload.message ?? record(payload.error).message ?? payload.error;
  return typeof message === "string" ? message.slice(0, 500) : "unknown provider error";
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`DeepSeek model catalog is missing ${label}.`);
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`DeepSeek model catalog is missing ${label}.`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function difference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

function formatRate(value: number | null): string {
  return value === null ? "not-reported" : `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
  return value === null ? "not-reported" : `$${value.toFixed(6)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
