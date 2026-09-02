import {
  ModelCurrencySnapshotSchema,
  type ContinualBenchPanelRelease,
  type ModelComparisonBenchmarkReceipt,
  type ModelComparisonParent,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
  type ModelCurrencySnapshot,
  type ModelRun,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";

type RequiredPanel = ContinualBenchPanelRelease & { role: Exclude<ContinualBenchPanelRelease["role"], "training_eligible"> };
type TerminalRun = ModelRun & { status: "succeeded" | "failed" | "cancelled" };
type Receipt = ModelComparisonBenchmarkReceipt;

export function createModelCurrencyProjectionService(store: SqliteStore) {
  async function reconcileEntry(entryId: string): Promise<ModelCurrencySnapshot | null> {
    const entry = await store.getModelComparisonSeriesEntry(entryId);
    if (!entry?.modelVersionId) return null;
    const series = await store.getModelComparisonSeries(entry.seriesId);
    if (!series?.benchmarkProtocol || !series.scheduleSealedAt) return null;
    const candidate = await store.getModelVersion(entry.modelVersionId);
    if (!candidate || candidate.contentHash.length !== 64) return null;

    const panels = currencyPanelsForEntry(series, entry);
    const runs = (await store.listModelRuns()).filter((run) => belongsToPair(run, series, entry));
    const selected = panels.flatMap((panel) => [
      selectRun(runs, panel.id, entry.parent),
      selectRun(runs, panel.id, { kind: "model_version", id: candidate.id, contentHash: candidate.contentHash }),
    ]);
    const snapshot = await projectSnapshot({ store, series, entry, panels, selected, candidate: { id: candidate.id, contentHash: candidate.contentHash } });
    return store.saveModelCurrencySnapshot(snapshot);
  }

  async function reconcileAll(): Promise<ModelCurrencySnapshot[]> {
    const entries = await store.listModelComparisonSeriesEntries();
    const projected: ModelCurrencySnapshot[] = [];
    for (const entry of entries) {
      const snapshot = await reconcileEntry(entry.id);
      if (snapshot) projected.push(snapshot);
    }
    return projected;
  }

  return { reconcileEntry, reconcileAll };
}

async function projectSnapshot(input: {
  store: SqliteStore;
  series: ModelComparisonSeries;
  entry: ModelComparisonSeriesEntry;
  panels: RequiredPanel[];
  selected: Array<ModelRun | null>;
  candidate: { id: string; contentHash: string };
}): Promise<ModelCurrencySnapshot> {
  const protocol = input.series.benchmarkProtocol!;
  const runByPanelTarget = new Map<string, ModelRun>();
  for (const run of input.selected) {
    if (!run?.evaluation || run.evaluation.benchmarkId !== "model-comparison" || !run.evaluation.panel) continue;
    runByPanelTarget.set(`${run.evaluation.panel.id}:${targetKey(run)}`, run);
  }
  const tasksets = new Map<string, Taskset>();
  for (const panel of input.panels) {
    const taskset = await input.store.getTasksetRevision(panel.taskset.id, panel.taskset.revision, panel.taskset.contentHash)
      ?? await input.store.getTaskset(panel.taskset.id);
    if (!taskset || !sameRef(taskset, panel.taskset)) throw new Error(`Currency projection cannot resolve sealed panel ${panel.id}.`);
    tasksets.set(panel.id, taskset);
  }

  const parentKey = policyKey(input.entry.parent);
  const candidateKey = `model_version:${input.candidate.id}`;
  const matches: ModelCurrencySnapshot["matches"] = [];
  const panelMetrics: ModelCurrencySnapshot["panels"] = [];
  let allRequiredAttemptsTerminal = true;
  for (const panel of input.panels) {
    const taskset = tasksets.get(panel.id)!;
    const parentRun = runByPanelTarget.get(`${panel.id}:${parentKey}`) ?? null;
    const candidateRun = runByPanelTarget.get(`${panel.id}:${candidateKey}`) ?? null;
    const parentReceipt = comparisonReceipt(parentRun);
    const candidateReceipt = comparisonReceipt(candidateRun);
    const expectedAttempts = taskset.tasks.length * protocol.evaluation.seeds.length * protocol.evaluation.repetitions;
    if (!isSuccessfulComplete(parentRun, parentReceipt, expectedAttempts) || !isSuccessfulComplete(candidateRun, candidateReceipt, expectedAttempts)) {
      allRequiredAttemptsTerminal = false;
    }
    const parentAttempts = attemptMap(parentReceipt);
    const candidateAttempts = attemptMap(candidateReceipt);
    for (const task of taskset.tasks) {
      for (const seed of protocol.evaluation.seeds) {
        for (let repetition = 0; repetition < protocol.evaluation.repetitions; repetition += 1) {
          const key = attemptKey(task.id, seed, repetition);
          const parentAttempt = parentAttempts.get(key) ?? null;
          const candidateAttempt = candidateAttempts.get(key) ?? null;
          matches.push({
            key: `${panel.id}:${key}`,
            panelId: panel.id,
            panelRole: panel.role,
            taskId: task.id,
            issueFamilyId: task.clusterKey,
            seed,
            repetition,
            classification: classify(parentAttempt?.passed ?? null, candidateAttempt?.passed ?? null),
            parentPassed: parentAttempt?.passed ?? null,
            candidatePassed: candidateAttempt?.passed ?? null,
            parentAttempt: evidenceRef(parentRun, parentAttempt),
            candidateAttempt: evidenceRef(candidateRun, candidateAttempt),
          });
        }
      }
    }
    const available = candidateReceipt?.attempts.filter((attempt) => attempt.status === "succeeded" && attempt.passed !== null) ?? [];
    const passed = available.filter((attempt) => attempt.passed).length;
    panelMetrics.push({
      panelId: panel.id,
      panelRole: panel.role,
      passLabel: panel.passLabel,
      taskset: panel.taskset,
      attempted: candidateReceipt?.attempts.length ?? 0,
      available: available.length,
      passed,
      strictSuccess: available.length ? passed / available.length : null,
      strictSuccessCi95: available.length ? wilsonInterval(passed, available.length) : null,
      judgeScore: candidateReceipt?.judge?.score ?? null,
      judgeScoreCi95: candidateReceipt?.judge?.scoreCi95 ?? null,
    });
  }

  const comparable = matches.filter((match) => match.parentPassed !== null && match.candidatePassed !== null);
  const wins = comparable.filter((match) => !match.parentPassed && match.candidatePassed).length;
  const losses = comparable.filter((match) => match.parentPassed && !match.candidatePassed).length;
  const ties = comparable.length - wins - losses;
  const strictDelta = comparable.length ? (wins - losses) / comparable.length : null;
  const correction = matches.filter((match) => match.panelRole === "correction" && match.candidatePassed !== null);
  const sibling = matches.filter((match) => match.panelRole === "sibling_verification" && match.candidatePassed !== null);
  const retained = matches.filter((match) => match.panelRole === "retained" && match.parentPassed !== null && match.candidatePassed !== null);
  const known = matches.filter((match) => match.panelRole === "cumulative_known" && match.candidatePassed !== null);
  const priorPassing = matches.filter((match) => ["cumulative_known", "development", "retained"].includes(match.panelRole) && match.parentPassed === true);
  const behavioralRetention = priorPassing.length ? priorPassing.filter((match) => match.candidatePassed === true).length / priorPassing.length : null;
  const correctionRate = passRate(correction.map((match) => match.candidatePassed));
  const siblingRate = passRate(sibling.map((match) => match.candidatePassed));
  const retainedParentRate = passRate(retained.map((match) => match.parentPassed));
  const retainedCandidateRate = passRate(retained.map((match) => match.candidatePassed));
  const retainedRegressionPoints = retainedParentRate === null || retainedCandidateRate === null ? null : (retainedParentRate - retainedCandidateRate) * 100;
  const criticalPriorRegressionCount = new Set(priorPassing.filter((match) => match.candidatePassed === false).map((match) => match.taskId)).size;
  const thresholds = protocol.currencyThresholds;
  const reasons: string[] = [];
  if (!allRequiredAttemptsTerminal) reasons.push("required_attempts_pending_or_unavailable");
  if (correctionRate === null || correctionRate < thresholds.criticalCorrectionPassRate) reasons.push("critical_correction_threshold_not_met");
  if (siblingRate === null || siblingRate < thresholds.siblingPassRate) reasons.push("sibling_threshold_not_met");
  if (behavioralRetention === null || behavioralRetention < thresholds.behavioralRetentionRate) reasons.push("behavioral_retention_threshold_not_met");
  if (retainedRegressionPoints === null || retainedRegressionPoints > thresholds.maximumRetainedRegressionPoints) reasons.push("retained_regression_threshold_not_met");
  if (thresholds.blockCriticalPriorRegression && criticalPriorRegressionCount > 0) reasons.push("critical_prior_regression_detected");
  const evidenceState = !allRequiredAttemptsTerminal ? "measuring" as const : reasons.length ? "needs_attention" as const : "up_to_date" as const;
  const terminalRuns = [...runByPanelTarget.values()].filter(isTerminalRun);
  const receipts = terminalRuns.map(comparisonReceipt).filter((value): value is Receipt => value !== null);
  const taskIds = classifyTaskIds(matches);
  const candidateUsage = sumUsage(receipts.filter((receipt) => receipt.target.kind === "model_version" && receipt.target.modelVersionId === input.candidate.id));
  const projectedAt = terminalRuns.map((run) => run.completedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? input.entry.updatedAt;
  const thresholdRelease = { id: `currency-thresholds-v${thresholds.revision}`, contentHash: contentHash(thresholds) };
  const bootstrap = strictDelta === null ? null : pairedBootstrapInterval(comparable, protocol.evaluation.pairedBootstrapSamples, contentHash({ entryId: input.entry.id, matches: comparable.map((match) => match.key) }));
  const content = {
    schemaVersion: "openpond.modelCurrencySnapshot.v1" as const,
    seriesId: input.series.id,
    protocol: { id: protocol.id, revision: protocol.revision, contentHash: protocol.contentHash },
    entryId: input.entry.id,
    passLabel: input.entry.label,
    parent: input.entry.parent,
    candidate: { kind: "model_version" as const, ...input.candidate },
    sources: {
      evaluationRunIds: [...runByPanelTarget.values()].map((run) => run.id).sort(),
      attemptIds: receipts.flatMap((receipt) => receipt.attempts.map((attempt) => attempt.attemptId).filter((value): value is string => Boolean(value))).sort(),
      tasksets: input.panels.map((panel) => panel.taskset),
      grader: protocol.grader,
      judge: protocol.judge?.release ?? null,
      calibration: protocol.judge?.calibrationRelease ?? null,
    },
    matches,
    taskIds,
    panels: panelMetrics,
    metrics: {
      knownIssueCoverage: passRate(known.map((match) => match.candidatePassed)),
      issueFamilyGeneralization: siblingRate,
      behavioralRetention,
      currentAcquisitionDelta: pairedDelta(correction),
      retainedDeltaPoints: retainedParentRate === null || retainedCandidateRate === null ? null : (retainedCandidateRate - retainedParentRate) * 100,
      frontierStrictDelta: null,
      pairedPValue: exactPairedBinaryPValue(wins, losses),
      wins,
      ties,
      losses,
    },
    statistics: {
      matchedAttemptCount: comparable.length,
      strictDelta,
      strictDeltaCi95: bootstrap,
      exactPairedBinaryPValue: exactPairedBinaryPValue(wins, losses),
      pairedBootstrapSamples: protocol.evaluation.pairedBootstrapSamples,
    },
    criteria: {
      allRequiredAttemptsTerminal,
      criticalCorrectionPassRate: correctionRate,
      siblingPassRate: siblingRate,
      behavioralRetentionRate: behavioralRetention,
      retainedRegressionPoints,
      criticalPriorRegressionCount,
      thresholdRelease,
    },
    efficiency: candidateUsage,
    invariants: {
      systemPromptHash: protocol.invariants.systemPromptHash,
      toolSchema: protocol.invariants.toolSchema,
      application: protocol.invariants.application,
      harness: protocol.invariants.harness,
      runtime: protocol.invariants.runtime,
      grader: protocol.grader,
      autoRefinerEnabled: protocol.invariants.autoRefiner.enabled,
    },
    evidenceState,
    evidenceReasons: reasons,
    projectedAt,
  };
  const hash = contentHash(content);
  return ModelCurrencySnapshotSchema.parse({ ...content, id: `model_currency_${hash.slice(0, 24)}`, contentHash: hash });
}

export function currencyPanelsForEntry(series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry): RequiredPanel[] {
  const protocol = series.benchmarkProtocol!;
  const scheduled = protocol.schedule.find((candidate) => candidate.scheduleEntryId === entry.scheduleEntryId);
  if (!scheduled) throw new Error("Currency projection cannot resolve the entry in the sealed protocol schedule.");
  const correctionIds = new Set(scheduled.correctionPanelIds);
  const correctionLabels = new Set(protocol.panels.filter((panel) => correctionIds.has(panel.id)).map((panel) => panel.passLabel));
  const ordinalByLabel = new Map(protocol.schedule.map((candidate) => [candidate.label, candidate.ordinal]));
  return protocol.panels.filter((panel): panel is RequiredPanel => {
    if (panel.role === "training_eligible") return false;
    if (panel.role === "correction") return correctionIds.has(panel.id);
    if (panel.role === "sibling_verification") return correctionLabels.has(panel.passLabel);
    if (panel.role === "cumulative_known") return (ordinalByLabel.get(panel.passLabel ?? "") ?? Number.POSITIVE_INFINITY) <= entry.ordinal;
    if (panel.role === "frozen_final") return true;
    return panel.role === "development" || panel.role === "retained";
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function belongsToPair(run: ModelRun, series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry): boolean {
  const evaluation = run.evaluation;
  return run.kind === "evaluation"
    && evaluation?.benchmarkId === "model-comparison"
    && evaluation.series?.id === series.id
    && evaluation.series.protocol.contentHash === series.benchmarkProtocol?.contentHash
    && evaluation.comparisonPair?.entryId === entry.id;
}

function selectRun(runs: ModelRun[], panelId: string, target: ModelComparisonParent | { kind: "model_version"; id: string; contentHash: string }): ModelRun | null {
  const matches = runs.filter((run) => run.evaluation?.benchmarkId === "model-comparison" && run.evaluation.panel?.id === panelId && targetKey(run) === policyKey(target));
  const successful = matches.filter((run) => run.status === "succeeded" && comparisonReceipt(run));
  return [...(successful.length ? successful : matches)].sort((left, right) => `${left.completedAt ?? left.updatedAt}:${left.id}`.localeCompare(`${right.completedAt ?? right.updatedAt}:${right.id}`)).at(-1) ?? null;
}

function targetKey(run: ModelRun): string {
  const target = run.evaluation?.benchmarkId === "model-comparison" ? run.evaluation.target : null;
  return target ? target.kind === "model_version" ? `model_version:${target.modelVersionId ?? "missing"}` : `${target.kind}:${target.label}` : "missing";
}

function policyKey(target: ModelComparisonParent | { kind: "model_version"; id: string; contentHash: string }): string {
  return target.kind === "model_version" ? `model_version:${target.id}` : `base_model:${target.id}`;
}

function comparisonReceipt(run: ModelRun | null): Receipt | null {
  return run?.receipt?.schemaVersion === "openpond.modelComparisonBenchmarkReceipt.v1" ? run.receipt : null;
}

function isSuccessfulComplete(run: ModelRun | null, receipt: Receipt | null, expected: number): boolean {
  return run?.status === "succeeded" && receipt !== null && receipt.attempts.length === expected && receipt.attempts.every((attempt) => attempt.status === "succeeded" || attempt.status === "failed");
}

function isTerminalRun(run: ModelRun): run is TerminalRun { return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled"; }
function sameRef(left: { id: string; revision: number; contentHash: string }, right: { id: string; revision: number; contentHash: string }) { return left.id === right.id && left.revision === right.revision && left.contentHash === right.contentHash; }
function attemptKey(taskId: string, seed: number, repetition: number) { return `${taskId}:${seed}:${repetition}`; }
function attemptMap(receipt: Receipt | null) { return new Map((receipt?.attempts ?? []).map((attempt) => [attemptKey(attempt.taskId, attempt.seed, attempt.repetition), attempt])); }
function classify(parent: boolean | null, candidate: boolean | null): "fixed" | "retained" | "regressed" | "unresolved" | "unavailable" { if (parent === null || candidate === null) return "unavailable"; if (!parent && candidate) return "fixed"; if (parent && candidate) return "retained"; if (parent && !candidate) return "regressed"; return "unresolved"; }
function evidenceRef(run: ModelRun | null, attempt: Receipt["attempts"][number] | null): ModelCurrencySnapshot["matches"][number]["parentAttempt"] { if (!run || !attempt?.attemptId || !attempt.transcriptArtifact || !attempt.traceArtifact) return null; return { evaluationRunId: run.id, attemptKey: attempt.attemptId, artifactPath: attempt.transcriptArtifact.artifactPath, jsonPointer: attempt.transcriptArtifact.jsonPointer, transcriptHash: attempt.transcriptHash, traceHash: attempt.traceHash }; }
function passRate(values: Array<boolean | null>): number | null { const available = values.filter((value): value is boolean => value !== null); return available.length ? available.filter(Boolean).length / available.length : null; }
function pairedDelta(matches: ModelCurrencySnapshot["matches"]): number | null { const comparable = matches.filter((match) => match.parentPassed !== null && match.candidatePassed !== null); return comparable.length ? comparable.reduce((sum, match) => sum + Number(match.candidatePassed) - Number(match.parentPassed), 0) / comparable.length : null; }

function classifyTaskIds(matches: ModelCurrencySnapshot["matches"]): ModelCurrencySnapshot["taskIds"] {
  const grouped = new Map<string, typeof matches>();
  for (const match of matches) grouped.set(match.taskId, [...(grouped.get(match.taskId) ?? []), match]);
  const result: ModelCurrencySnapshot["taskIds"] = { fixed: [], retained: [], regressed: [], unresolved: [], unavailable: [] };
  for (const [taskId, attempts] of grouped) {
    const comparable = attempts.filter((attempt) => attempt.parentPassed !== null && attempt.candidatePassed !== null);
    if (!comparable.length) { result.unavailable.push(taskId); continue; }
    const parent = passRate(comparable.map((attempt) => attempt.parentPassed))!;
    const candidate = passRate(comparable.map((attempt) => attempt.candidatePassed))!;
    if (candidate > parent) result.fixed.push(taskId);
    else if (candidate < parent) result.regressed.push(taskId);
    else if (candidate > 0) result.retained.push(taskId);
    else result.unresolved.push(taskId);
  }
  for (const values of Object.values(result)) values.sort();
  return result;
}

function sumUsage(receipts: Receipt[]): ModelCurrencySnapshot["efficiency"] {
  const inputTokens = receipts.reduce((sum, receipt) => sum + (receipt.usage.policy?.inputTokens ?? 0), 0);
  const outputTokens = receipts.reduce((sum, receipt) => sum + (receipt.usage.policy?.outputTokens ?? 0), 0);
  const totalTokens = receipts.reduce((sum, receipt) => sum + (receipt.usage.policy?.totalTokens ?? 0), 0);
  const costs = receipts.map((receipt) => receipt.usage.observedSpendUsd).filter((value): value is number => value !== null);
  const gpu = receipts.map((receipt) => receipt.usage.evaluationGpuSeconds).filter((value): value is number => value !== null);
  const latencyMs = receipts.flatMap((receipt) => receipt.attempts.map((attempt) => attempt.latencyMs)).filter((value): value is number => value !== null).reduce((sum, value) => sum + value, 0);
  const successes = receipts.reduce((sum, receipt) => sum + receipt.deterministic.passedTaskCount, 0);
  return { inputTokens, outputTokens, totalTokens, costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, latencyMs, tokensPerSuccess: successes ? totalTokens / successes : null, throughputPerHour: latencyMs > 0 ? successes * 3_600_000 / latencyMs : null, gpuSeconds: gpu.length ? gpu.reduce((sum, value) => sum + value, 0) : null };
}

function wilsonInterval(successes: number, total: number) { const z = 1.959963984540054; const p = successes / total; const denominator = 1 + z * z / total; const center = (p + z * z / (2 * total)) / denominator; const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator; return { level: 0.95 as const, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) }; }
function exactPairedBinaryPValue(wins: number, losses: number): number | null { const n = wins + losses; if (!n) return null; const k = Math.min(wins, losses); let cumulative = 0; for (let index = 0; index <= k; index += 1) cumulative += binomial(n, index) * 0.5 ** n; return Math.min(1, 2 * cumulative); }
function binomial(n: number, k: number): number { let value = 1; for (let index = 1; index <= k; index += 1) value = value * (n - index + 1) / index; return value; }
function pairedBootstrapInterval(matches: ModelCurrencySnapshot["matches"], samples: number, seedHash: string) { let state = Number.parseInt(seedHash.slice(0, 8), 16) || 1; const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; }; const values = matches.map((match) => Number(match.candidatePassed) - Number(match.parentPassed)); const estimates: number[] = []; for (let sample = 0; sample < samples; sample += 1) { let sum = 0; for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)]!; estimates.push(sum / values.length); } estimates.sort((left, right) => left - right); return { level: 0.95 as const, lower: estimates[Math.floor(samples * 0.025)]!, upper: estimates[Math.min(samples - 1, Math.ceil(samples * 0.975) - 1)]! }; }
