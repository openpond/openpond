import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  assertOptimizerIsolation,
  contentHash,
  createContinualBenchPanelAllocations,
  createContinualBenchReport,
  createContinualBenchSplit,
  exportContinualBenchReport,
  requireValidContinualBenchManifest,
  sealPortableManifest,
  validateContinualBenchManifest,
  type ContinualBenchPortableManifest,
  type ContinualBenchPortablePanel,
} from "@openpond/continual-support";
import yaml from "js-yaml";

import { optionString, parseBooleanOption, parseIntegerOption, parseNumberOption } from "./common/options";
import { resolveApiBaseUrlOption } from "./common/urls";
import { createLocalAuthenticatedRequest, DEFAULT_LOCAL_TRAINING_API_URL } from "./training";

type ContinualDependencies = {
  request?: typeof fetch;
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  prompt?: (question: string) => Promise<string>;
  log?: (message: string) => void;
};

type SourceRow = {
  id: string;
  familyId: string | null;
  passLabel: string | null;
  panelRole: ContinualBenchPortablePanel["role"] | null;
  prompt?: string;
  payload: Record<string, unknown>;
};

export async function runContinualCommand(
  options: Record<string, string | boolean>,
  rest: string[],
  dependencies: ContinualDependencies = {},
): Promise<void> {
  const subcommand = rest[0];
  if (!subcommand || !["init", "validate", "run", "report"].includes(subcommand)) {
    throw new Error("usage: openpond continual <init|validate|run|report> [manifest-or-series-id]");
  }
  const log = dependencies.log ?? console.log;
  if (subcommand === "init") {
    await initializeManifest(options, rest.slice(1), dependencies, log);
    return;
  }
  if (subcommand === "report") {
    await exportReport(options, rest.slice(1), dependencies, log);
    return;
  }
  const manifestPath = rest[1];
  if (!manifestPath || rest.length !== 2) throw new Error(`usage: openpond continual ${subcommand} <manifest-path>`);
  const manifestValue = await loadStructuredFile(path.resolve(manifestPath), dependencies.readFile ?? readFile);
  const validation = validateContinualBenchManifest(manifestValue);
  if (subcommand === "validate") {
    if (parseBooleanOption(options.json)) log(JSON.stringify(validation, null, 2));
    else {
      log(validation.valid ? `Valid Continual Support manifest ${validation.manifestHash}.` : "Continual Support manifest is invalid.");
      log(`Leakage audit ${validation.leakageHash ?? "unavailable"}; ${validation.issues.length} finding(s).`);
      for (const issue of validation.issues) log(`${issue.severity}: ${issue.code} at ${issue.path}: ${issue.message}`);
    }
    if (!validation.valid) throw withExitCode("Continual Support validation failed.", 2);
    return;
  }
  const manifest = requireValidContinualBenchManifest(manifestValue);
  assertOptimizerIsolation(manifest);
  await submitManifest(manifest, options, dependencies, log);
}

async function initializeManifest(
  options: Record<string, string | boolean>,
  rest: string[],
  dependencies: ContinualDependencies,
  log: (message: string) => void,
): Promise<void> {
  if (rest.length) throw new Error("continual init accepts --from and --output options, not positional arguments.");
  const sourcePath = optionString(options, "from");
  if (!sourcePath) throw new Error("continual init requires --from <tasks.json|tasks.jsonl>.");
  const outputPath = path.resolve(optionString(options, "output") || "continual-support.yaml");
  const rows = await readSourceRows(path.resolve(sourcePath), dependencies.readFile ?? readFile);
  const nonInteractive = parseBooleanOption(options.nonInteractive) || !process.stdin.isTTY;
  const prompt = dependencies.prompt ?? defaultPrompt;
  const normalized = await completeLabels(rows, nonInteractive, prompt);
  const splitRows = normalized.filter((row) => row.panelRole === null || row.panelRole === "correction" || row.panelRole === "sibling_verification");
  const passes = [...new Map(splitRows.map((row) => [row.passLabel!, row])).keys()].sort().map((label) => ({
    label,
    familyIds: [...new Set(splitRows.filter((row) => row.passLabel === label).map((row) => row.familyId!))].sort(),
  }));
  const tasks = normalized.map((row) => ({
    id: row.id,
    familyId: row.familyId!,
    contentHash: contentHash(row.payload),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    payload: row.payload,
  }));
  const split = createContinualBenchSplit({
    tasks: splitRows.map((row) => ({ id: row.id, familyId: row.familyId!, contentHash: contentHash(row.payload), prompt: row.prompt })),
    passes,
    seed: optionString(options, "seed") || "continual-support-v1",
    correctionCasesPerFamily: parseIntegerOption(options.correctionCasesPerFamily, "correction-cases-per-family") ?? 1,
    correctionSelection: optionString(options, "correctionSelection") === "stable_hash" ? "stable_hash" : "minimize_prompt_similarity",
  });
  if (split.advisories.length) {
    throw new Error(`The proposed split is incomplete and was not weakened: ${split.advisories.map((item) => `${item.code}:${item.familyId}`).join(", ")}`);
  }
  const generatedPanels: ContinualBenchPortablePanel[] = createContinualBenchPanelAllocations(split).map((panel) => ({
    id: panel.id,
    role: panel.role,
    passLabel: panel.passLabel,
    taskIds: panel.taskIds,
    disclosurePhase: panel.role === "sibling_verification" ? "evaluation" : "review",
    optimizerEligible: panel.optimizerEligible,
  }));
  const stableRoles = ["development", "retained", "frozen_final"] as const;
  for (const role of stableRoles) {
    const taskIds = normalized.filter((row) => row.panelRole === role).map((row) => row.id).sort();
    if (taskIds.length) generatedPanels.push({
      id: role.replace("_", "-"),
      role,
      passLabel: null,
      taskIds,
      disclosurePhase: role === "frozen_final" ? "final" : "evaluation",
      optimizerEligible: false,
    });
  }
  const id = optionString(options, "id") || slug(optionString(options, "name") || path.basename(sourcePath, path.extname(sourcePath)));
  const graderId = optionString(options, "grader") || "user-supplied-grader-v1";
  const unsealed: Omit<ContinualBenchPortableManifest, "contentHash"> = {
    schemaVersion: "openpond.continualBenchManifest.v1",
    id,
    revision: 1,
    name: optionString(options, "name") || id,
    description: optionString(options, "description") || "A sealed continual-support workflow converted from an ordinary task set.",
    license: optionString(options, "license") || "UNSPECIFIED",
    source: { repository: optionString(options, "repository") || null, commit: optionString(options, "commit") || null, generatedBy: `openpond continual init --from ${sourcePath}` },
    split: {
      seed: split.seed,
      correctionCasesPerFamily: parseIntegerOption(options.correctionCasesPerFamily, "correction-cases-per-family") ?? 1,
      correctionSelection: optionString(options, "correctionSelection") === "stable_hash" ? "stable_hash" : "minimize_prompt_similarity",
      semanticSimilarityThreshold: parseNumberOption(options.semanticSimilarityThreshold, "semantic-similarity-threshold") ?? 0.8,
    },
    passes,
    tasks,
    panels: generatedPanels,
    grader: { id: graderId, contentHash: contentHash({ id: graderId }), outcomeScale: { minimum: 0, maximum: 1 } },
    evaluation: { seeds: [1701, 1709, 1721], repetitions: 3, confidenceLevel: 0.95, pairedBootstrapSamples: 10_000 },
  };
  const manifest = sealPortableManifest(unsealed);
  const serialized = outputPath.endsWith(".json")
    ? `${JSON.stringify(manifest, null, 2)}\n`
    : yaml.dump(manifest, { noRefs: true, lineWidth: 120, sortKeys: false });
  await (dependencies.writeFile ?? writeFile)(outputPath, serialized, "utf8");
  log(`Created ${outputPath}.`);
  log(`Manifest ${manifest.contentHash}; split ${split.contentHash}.`);
}

async function submitManifest(
  manifest: ContinualBenchPortableManifest,
  options: Record<string, string | boolean>,
  dependencies: ContinualDependencies,
  log: (message: string) => void,
): Promise<void> {
  if (!manifest.execution) throw new Error("This manifest validates locally but needs an execution.openpond series binding before `continual run`.");
  const series = { ...manifest.execution.series } as Record<string, unknown>;
  const benchmarkProtocol = series.benchmarkProtocol as Record<string, unknown> | undefined;
  const issueFamilyLedger = object(benchmarkProtocol?.issueFamilyLedger);
  if (!benchmarkProtocol || issueFamilyLedger.contentHash !== manifest.contentHash) {
    throw new Error("execution.series.benchmarkProtocol.issueFamilyLedger must bind the exact sealed portable manifest hash.");
  }
  const baseUrl = resolveApiBaseUrlOption(options) ?? manifest.execution.apiBaseUrl ?? process.env.OPENPOND_LOCAL_API_URL?.replace(/\/$/, "") ?? DEFAULT_LOCAL_TRAINING_API_URL;
  const request = dependencies.request ?? await createLocalAuthenticatedRequest(baseUrl);
  const saved = object(await requestJson(request, `${baseUrl}/v1/training/comparison-series`, "POST", { series }));
  const seriesId = string(saved.id) || string(series.id);
  const revision = number(saved.revision);
  if (!seriesId || !revision) throw new Error("OpenPond did not return a Comparison Series identity and revision.");
  await requestJson(request, `${baseUrl}/v1/training/comparison-series/${encodeURIComponent(seriesId)}/seal`, "POST", { expectedRevision: revision });
  const canonicalUrl = `/models/comparisons/${encodeURIComponent(seriesId)}`;
  const result = { comparisonSeriesId: seriesId, canonicalUrl, protocolHash: manifest.contentHash };
  log(parseBooleanOption(options.json) ? JSON.stringify(result, null, 2) : `Created and sealed Comparison Series ${seriesId}.\n${canonicalUrl}\nNo release was queued or started.`);
}

async function exportReport(
  options: Record<string, string | boolean>,
  rest: string[],
  dependencies: ContinualDependencies,
  log: (message: string) => void,
): Promise<void> {
  const seriesId = rest[0];
  if (!seriesId || rest.length !== 1) throw new Error("usage: openpond continual report <comparison-series-id> [--output <path>]");
  const baseUrl = resolveApiBaseUrlOption(options) ?? process.env.OPENPOND_LOCAL_API_URL?.replace(/\/$/, "") ?? DEFAULT_LOCAL_TRAINING_API_URL;
  const request = dependencies.request ?? await createLocalAuthenticatedRequest(baseUrl);
  const state = object(await requestJson(request, `${baseUrl}/v1/training`, "GET"));
  const series = array(state.comparisonSeries).map(object).find((item) => item.id === seriesId);
  if (!series) throw new Error(`Comparison Series ${seriesId} was not found.`);
  const protocol = object(series.benchmarkProtocol);
  const entries = array(state.comparisonSeriesEntries).map(object).filter((item) => item.seriesId === seriesId);
  const snapshots = array(state.modelCurrencySnapshots).map(object).filter((item) => item.seriesId === seriesId);
  const snapshotByEntry = new Map(snapshots.map((item) => [string(item.entryId), item]));
  const points = entries.filter((entry) => string(entry.modelVersionId)).map((entry) => {
    const snapshot = snapshotByEntry.get(string(entry.id));
    const panels = array(snapshot?.panels).map(object);
    const available = panels.map((panel) => numberOrNull(panel.strictSuccess)).filter((value): value is number => value !== null);
    const strict = available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
    const efficiency = objectOrNull(snapshot?.efficiency);
    return {
      id: string(entry.id)!, label: string(entry.label)!, kind: "candidate" as const, ordinal: numberOrNull(entry.ordinal), meanScore: strict,
      confidenceInterval: null, taskMetrics: [],
      efficiency: efficiency ? {
        targetId: string(entry.modelVersionId)!, trainingGpuSeconds: numberOrNull(efficiency.gpuSeconds), evaluationGpuSeconds: null,
        providerSpendUsd: null, totalSpendUsd: numberOrNull(efficiency.costUsd), durationSeconds: numberOrNull(efficiency.latencyMs) === null ? null : numberOrNull(efficiency.latencyMs)! / 1_000,
        optimizerGroups: null, trajectories: null,
      } : null,
      evidenceUrl: `${baseUrl}/models/comparisons/${encodeURIComponent(seriesId)}`,
    };
  });
  if (!points.length) throw new Error(`Comparison Series ${seriesId} has no receipt-derived candidate points to report.`);
  const terminal = entries.every((entry) => ["candidate", "accepted", "rejected", "no_signal", "failed", "cancelled"].includes(string(entry.status) || ""));
  const report = createContinualBenchReport({
    schemaVersion: "openpond.continualBenchReport.v1",
    seriesId,
    protocol: { id: string(protocol.id)!, revision: number(protocol.revision)!, contentHash: string(protocol.contentHash)! },
    generatedAt: new Date().toISOString(), status: terminal ? "terminal" : "partial", points, outcomes: [],
    audit: [{ requirement: "receipt-derived-points", status: "passed", evidenceRefs: points.map((point) => point.id) }],
  });
  const serialized = exportContinualBenchReport(report);
  const output = optionString(options, "output");
  if (output) {
    await (dependencies.writeFile ?? writeFile)(path.resolve(output), serialized, "utf8");
    log(`Wrote ${path.resolve(output)} (${report.contentHash}).`);
  } else log(serialized.trimEnd());
}

async function loadStructuredFile(filePath: string, reader: typeof readFile): Promise<unknown> {
  const source = await reader(filePath, "utf8");
  return filePath.endsWith(".json") ? JSON.parse(source) : yaml.load(source);
}

async function readSourceRows(filePath: string, reader: typeof readFile): Promise<SourceRow[]> {
  const source = await reader(filePath, "utf8");
  const values = filePath.endsWith(".jsonl")
    ? source.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
        try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${index + 1}.`); }
      })
    : JSON.parse(source);
  if (!Array.isArray(values) || !values.length) throw new Error("The source must contain a non-empty JSON array or JSONL sequence.");
  return values.map((value, index) => normalizeSourceRow(value, index));
}

function normalizeSourceRow(value: unknown, index: number): SourceRow {
  const row = object(value);
  const id = string(row.id) || string(row.taskId) || string(row.task_id);
  if (!id) throw new Error(`Source row ${index + 1} is missing id/taskId.`);
  const familyId = string(row.familyId) || string(row.family_id) || string(row.clusterKey);
  const passLabel = string(row.passLabel) || string(row.pass_label);
  const rawRole = string(row.panelRole) || string(row.panel_role);
  const roles = new Set(["correction", "sibling_verification", "cumulative_known", "development", "retained", "frozen_final", "training_eligible"]);
  if (rawRole && !roles.has(rawRole)) throw new Error(`Source row ${id} has unsupported panel role ${rawRole}.`);
  return { id, familyId, passLabel, panelRole: rawRole as SourceRow["panelRole"], prompt: string(row.prompt) || string(objectOrNull(row.input)?.prompt) || undefined, payload: row };
}

async function completeLabels(rows: SourceRow[], nonInteractive: boolean, prompt: (question: string) => Promise<string>): Promise<SourceRow[]> {
  const output: SourceRow[] = [];
  const familyPass = new Map<string, string>();
  for (const row of rows) {
    let familyId = row.familyId;
    if (!familyId) {
      if (nonInteractive) throw new Error(`Task ${row.id} lacks familyId; non-interactive init never fabricates issue families.`);
      familyId = (await prompt(`Issue family for ${row.id}: `)).trim();
      if (!familyId) throw new Error(`Task ${row.id} requires an issue family.`);
    }
    let passLabel = row.passLabel;
    if (!row.panelRole || row.panelRole === "correction" || row.panelRole === "sibling_verification") {
      passLabel = passLabel || familyPass.get(familyId) || null;
      if (!passLabel) {
        if (nonInteractive) throw new Error(`Task family ${familyId} lacks passLabel; provide labels for CI.`);
        passLabel = (await prompt(`Pass label for family ${familyId}: `)).trim();
      }
      if (!passLabel) throw new Error(`Family ${familyId} requires a pass label.`);
      const existing = familyPass.get(familyId);
      if (existing && existing !== passLabel) throw new Error(`Family ${familyId} appears in both ${existing} and ${passLabel}.`);
      familyPass.set(familyId, passLabel);
    }
    output.push({ ...row, familyId, passLabel });
  }
  return output;
}

async function defaultPrompt(question: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return await input.question(question); } finally { input.close(); }
}

async function requestJson(request: typeof fetch, url: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  const response = await request(url, { method, headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`OpenPond request failed (${response.status}): ${string(objectOrNull(payload)?.error) || response.statusText}`);
  return payload;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function objectOrNull(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function numberOrNull(value: unknown): number | null { return number(value); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "continual-support"; }
function withExitCode(message: string, exitCode: number): Error { return Object.assign(new Error(message), { exitCode }); }
