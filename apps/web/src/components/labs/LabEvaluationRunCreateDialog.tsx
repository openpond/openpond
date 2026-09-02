import { useMemo, useState, type FormEvent } from "react";
import type {
  ContinualBenchPanelRelease,
  ModelComparisonEvaluationLink,
  ModelComparisonSeries,
  ModelComparisonSeriesEntry,
  ModelRun,
  TrainingStateResponse,
} from "@openpond/contracts";

import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";

type StartInput = {
  entryId: string;
  cohortRole: ModelComparisonEvaluationLink["cohortRole"];
  panelId: string;
  taskset: { id: string; revision: number; contentHash: string };
  targetModelVersionId: string;
  seeds?: number[];
  repetitions?: number;
  maximumSpendUsd: number;
  maxGpuSeconds: number;
};

export function LabEvaluationRunCreateDialog({
  busy,
  modelProjectId,
  onClose,
  onStart,
  state,
}: {
  busy: boolean;
  modelProjectId?: string | null;
  onClose: () => void;
  onStart: (input: StartInput) => Promise<ModelRun | null>;
  state: TrainingStateResponse;
}) {
  const candidates = useMemo(() => evaluationCandidates(state, modelProjectId ?? null), [modelProjectId, state]);
  const [entryId, setEntryId] = useState(candidates[0]?.entry.id ?? "");
  const selected = candidates.find((candidate) => candidate.entry.id === entryId) ?? null;
  const panels = selected ? authorizedPanels(selected.series, selected.entry) : [];
  const [panelId, setPanelId] = useState(panels[0]?.id ?? "");
  const panel = panels.find((candidate) => candidate.id === panelId) ?? panels[0] ?? null;
  const [maximumSpendUsd, setMaximumSpendUsd] = useState(selected?.series.benchmarkProtocol?.resources.maximumProviderSpendUsd ?? 6);
  const [maxGpuSeconds, setMaxGpuSeconds] = useState(selected?.series.benchmarkProtocol?.resources.maximumEvaluationGpuSeconds ?? 7_200);
  const [error, setError] = useState<string | null>(null);

  function selectEntry(nextEntryId: string) {
    setEntryId(nextEntryId);
    const next = candidates.find((candidate) => candidate.entry.id === nextEntryId) ?? null;
    const nextPanels = next ? authorizedPanels(next.series, next.entry) : [];
    setPanelId(nextPanels[0]?.id ?? "");
    setMaximumSpendUsd(next?.series.benchmarkProtocol?.resources.maximumProviderSpendUsd ?? 6);
    setMaxGpuSeconds(next?.series.benchmarkProtocol?.resources.maximumEvaluationGpuSeconds ?? 7_200);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!selected || !panel || !selected.entry.modelVersionId) {
      setError("Select a trained comparison release and an authorized sealed panel.");
      return;
    }
    const run = await onStart({
      entryId: selected.entry.id,
      cohortRole: evaluationRole(panel),
      panelId: panel.id,
      taskset: panel.taskset,
      targetModelVersionId: selected.entry.modelVersionId,
      seeds: selected.series.benchmarkProtocol?.evaluation.seeds,
      repetitions: selected.series.benchmarkProtocol?.evaluation.repetitions,
      maximumSpendUsd,
      maxGpuSeconds,
    });
    if (!run) {
      setError("The Evaluation Run did not start. Review the training error for details.");
      return;
    }
    onClose();
  }

  return (
    <AppDialog ariaLabel="New evaluation run" backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-evaluation-create-dialog" dismissDisabled={busy} onClose={onClose}>
      <header><div><h2>New evaluation run</h2><p>Launch one exact candidate × sealed panel measurement. This does not make an operator decision.</p></div><button aria-label="Close" disabled={busy} type="button" onClick={onClose}><X size={16} /></button></header>
      <form onSubmit={(event) => void submit(event)}>
        <label><span>Comparison release</span><select required value={entryId} onChange={(event) => selectEntry(event.currentTarget.value)}><option value="">Select a trained release</option>{candidates.map(({ entry, series }) => <option key={entry.id} value={entry.id}>{series.name} · {entry.label}</option>)}</select></label>
        <label><span>Sealed panel</span><select required value={panel?.id ?? ""} onChange={(event) => setPanelId(event.currentTarget.value)}><option value="">Select an authorized panel</option>{panels.map((candidate) => <option key={candidate.id} value={candidate.id}>{panelLabel(candidate)}</option>)}</select></label>
        {selected?.series.benchmarkProtocol && panel ? <dl className="labs-inline-facts labs-evaluation-create-facts">
          <Fact label="Protocol" value={`${selected.series.benchmarkProtocol.id} · r${selected.series.benchmarkProtocol.revision}`} />
          <Fact label="Protocol hash" value={selected.series.benchmarkProtocol.contentHash} mono />
          <Fact label="Taskset" value={`${panel.taskset.id} · r${panel.taskset.revision}`} />
          <Fact label="Taskset hash" value={panel.taskset.contentHash} mono />
          <Fact label="Sampling" value={`${selected.series.benchmarkProtocol.evaluation.seeds.length} seeds × ${selected.series.benchmarkProtocol.evaluation.repetitions} repetitions`} />
          <Fact label="Target" value={`${selected.entry.label} · ${selected.entry.modelVersionId}`} mono />
        </dl> : <p className="labs-detail-copy">Only trained releases in a sealed Continual Support protocol can be evaluated here.</p>}
        <div className="labs-comparison-create-grid">
          <label><span>Maximum provider spend (USD)</span><input min="0.01" required step="0.01" type="number" value={maximumSpendUsd} onChange={(event) => setMaximumSpendUsd(Number(event.currentTarget.value))} /></label>
          <label><span>Maximum evaluation GPU seconds</span><input min="1" required step="1" type="number" value={maxGpuSeconds} onChange={(event) => setMaxGpuSeconds(Number(event.currentTarget.value))} /></label>
        </div>
        <p className="labs-detail-copy">Starting is explicit and may allocate paid evaluation resources. The evidence state will update independently; advance/hold remains a separate operator action.</p>
        {error ? <div className="labs-rename-error" role="alert">{error}</div> : null}
        {!candidates.length ? <div className="training-run-placeholder">No sealed comparison release has a trained Model Version yet.</div> : null}
        <footer><button disabled={busy} type="button" onClick={onClose}>Cancel</button><button disabled={busy || !selected || !panel || maximumSpendUsd <= 0 || maxGpuSeconds <= 0} type="submit">{busy ? "Starting…" : "Start evaluation"}</button></footer>
      </form>
    </AppDialog>
  );
}

function evaluationCandidates(state: TrainingStateResponse, modelProjectId: string | null) {
  const seriesById = new Map(state.comparisonSeries.map((series) => [series.id, series]));
  return state.comparisonSeriesEntries.flatMap((entry) => {
    const series = seriesById.get(entry.seriesId);
    if (!series?.scheduleSealedAt || !series.benchmarkProtocol || !entry.modelVersionId) return [];
    if (modelProjectId && entry.modelProjectId !== modelProjectId) return [];
    return [{ entry, series }];
  }).sort((left, right) => right.entry.updatedAt.localeCompare(left.entry.updatedAt));
}

function authorizedPanels(series: ModelComparisonSeries, entry: ModelComparisonSeriesEntry): ContinualBenchPanelRelease[] {
  const ordinalByLabel = new Map(series.schedule.map((scheduled) => [scheduled.label, scheduled.ordinal]));
  return (series.benchmarkProtocol?.panels ?? []).filter((panel) => {
    if (panel.role === "training_eligible") return false;
    if (!panel.passLabel) return true;
    const ordinal = ordinalByLabel.get(panel.passLabel);
    return ordinal !== undefined && ordinal <= entry.ordinal;
  });
}

function panelLabel(panel: ContinualBenchPanelRelease): string {
  return `${panel.passLabel ? `${panel.passLabel} · ` : ""}${panel.role.replaceAll("_", " ")} · ${panel.taskCount} task${panel.taskCount === 1 ? "" : "s"}`;
}

function evaluationRole(panel: ContinualBenchPanelRelease): ModelComparisonEvaluationLink["cohortRole"] {
  if (panel.role === "training_eligible") throw new Error("Training-eligible panels cannot be evaluated.");
  return panel.role;
}

function Fact({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return <div><dt>{label}</dt><dd className={mono ? "labs-mono-value" : undefined}>{value}</dd></div>;
}
