import { useEffect, useMemo, useState } from "react";
import {
  ManagedTrainingRunEvidenceSchema,
  type ManagedTrainingRunEvidence,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
  type TrainingRunDetail,
  type TrainingStateResponse,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import type { useTraining } from "../../hooks/useTraining";
import { ArrowLeft } from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";
import { LabComparisonQualityTrend } from "./LabComparisonQualityTrend";
import { LabComparisonCurrencyWorkspace } from "./LabComparisonCurrencyWorkspace";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

export function LabComparisonSeriesDetail({
  connection,
  onBack,
  onOpenEvaluation,
  onOpenProject,
  onOpenRun,
  onOpenTaskset,
  onOpenVersion,
  onSelectedEntryIdChange,
  onToast,
  selectedEntryId,
  series,
  state,
  training,
}: {
  connection: ClientConnection | null;
  onBack: () => void;
  onOpenEvaluation: (evaluationRunId: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenRun: (projectId: string, runId: string) => void;
  onOpenTaskset: (tasksetId: string) => void;
  onOpenVersion: (projectId: string, versionId: string) => void;
  onSelectedEntryIdChange: (entryId: string | null) => void;
  onToast: (message: string, tone: "success" | "error" | "info") => void;
  series: ModelComparisonSeries;
  selectedEntryId: string | null;
  state: TrainingStateResponse;
  training: ReturnType<typeof useTraining>;
}) {
  const entries = useMemo(() => state.comparisonSeriesEntries
    .filter((entry) => entry.seriesId === series.id)
    .sort((left, right) => left.ordinal - right.ordinal), [series.id, state.comparisonSeriesEntries]);
  const entryBySchedule = useMemo(() => new Map(entries.map((entry) => [entry.scheduleEntryId, entry])), [entries]);
  const selectedEntry = entries.find((entry) => entry.id === selectedEntryId) ?? null;
  const selectedRun = selectedEntry?.modelRunId
    ? state.modelRuns.find((run) => run.id === selectedEntry.modelRunId) ?? null
    : null;
  const selectedJob = selectedRun
    ? state.jobs.find((job) => job.metadata.modelRunId === selectedRun.id) ?? null
    : null;
  const [detail, setDetail] = useState<TrainingRunDetail | null>(null);
  const project = state.modelProjects.find((candidate) => candidate.id === series.modelProjectId) ?? null;
  const acceptedHead = entries.find((entry) => entry.id === series.acceptedDailyHeadEntryId) ?? null;
  const acceptedSeed = entries.find((entry) => entry.id === series.acceptedSeedEntryId) ?? null;
  const masterBinding = state.modelBindings.find((binding) =>
    binding.status === "active"
    && binding.profileId === series.profileId
    && binding.role === series.productionBinding.role
    && binding.roleTargetId === series.productionBinding.roleTargetId) ?? null;
  const masterEntry = masterBinding
    ? entries.find((entry) => {
        const version = state.modelVersions.find((candidate) => candidate.id === entry.modelVersionId);
        return version?.artifactLineageId === masterBinding.modelArtifactLineageId;
      }) ?? null
    : null;
  const seriesCost = entries.reduce((sum, entry) => sum + (entryEvidence(state, entry)?.cost.totalUsd ?? 0), 0);

  useEffect(() => {
    let disposed = false;
    if (!connection || !selectedJob) {
      setDetail(null);
      return () => { disposed = true; };
    }
    void api.trainingRunDetail(connection, selectedJob.id)
      .then((next) => { if (!disposed) setDetail(next); })
      .catch(() => { if (!disposed) setDetail(null); });
    return () => { disposed = true; };
  }, [connection, selectedJob]);

  async function seal() {
    const result = await training.actions.sealComparisonSeries(series.id, series.revision);
    onToast(result ? "Schedule sealed. No training was launched." : "Couldn’t seal the schedule.", result ? "success" : "error");
  }

  async function queueDerived(scheduleEntryId: string) {
    const result = await training.actions.queueComparisonRelease({
      seriesId: series.id,
      scheduleEntryId,
      taskSelection: null,
      expectedSeriesRevision: series.revision,
    });
    onToast(result ? `${result.entry.label} is ready. Start remains a separate action.` : "Couldn’t prepare this release.", result ? "success" : "error");
  }

  async function start(entry: ModelComparisonSeriesEntry) {
    if (!project) return;
    const result = await training.actions.startModelRun(project.id, {
      maximumSpendUsd: null,
      retentionDays: null,
      exportApproved: true,
      comparisonSeriesEntryId: entry.id,
    });
    onToast(result ? `${entry.label} started through the normal Model Run path.` : `${entry.label} did not start.`, result ? "success" : "error");
  }

  async function cancel(entry: ModelComparisonSeriesEntry) {
    if (!entry.modelRunId) return;
    const result = await training.actions.cancelModelRun(entry.modelRunId);
    onToast(result ? `Cancellation requested for ${entry.label}.` : `Couldn’t cancel ${entry.label}.`, result ? "info" : "error");
  }

  async function decide(entry: ModelComparisonSeriesEntry, disposition: "advance" | "hold") {
    const result = await training.actions.decideComparisonEntry({
      entryId: entry.id,
      expectedSeriesRevision: series.revision,
      decision: {
        disposition,
        policy: { id: series.advancementPolicy.id, version: series.advancementPolicy.version },
        reasonCodes: [disposition === "advance" ? "manual_review_accepted" : "manual_review_held"],
        summary: disposition === "advance"
          ? "Accepted after reviewing acquisition, retention, integrity, and resource evidence."
          : "Held after reviewing acquisition, retention, integrity, and resource evidence.",
        decidedBy: state.profileId,
        decidedAt: new Date().toISOString(),
      },
    });
    const advancedMessage = entry.role === "seed" || entry.role === "daily_residual"
      ? `${entry.label} is now the experimental parent for the next daily release.`
      : `${entry.label} is accepted as an independent comparison candidate.`;
    onToast(result ? (disposition === "advance" ? advancedMessage : `${entry.label} was held and will not parent another release.`) : `Couldn’t record the ${entry.label} decision.`, result ? "success" : "error");
  }

  async function promote(entry: ModelComparisonSeriesEntry) {
    const version = state.modelVersions.find((candidate) => candidate.id === entry.modelVersionId);
    if (!version?.artifactLineageId) return;
    const binding = await training.actions.bindModel(
      version.artifactLineageId,
      series.productionBinding.role,
      series.productionBinding.roleTargetId,
    );
    if (!binding) {
      onToast("The existing Model Binding service did not promote this Version.", "error");
      return;
    }
    const recorded = await training.actions.recordComparisonPromotion({
      entryId: entry.id,
      bindingId: binding.id,
      expectedSeriesRevision: series.revision,
    });
    onToast(recorded ? `${entry.label} is now Master.` : "The binding changed, but its series receipt was not recorded.", recorded ? "success" : "error");
  }

  async function rollbackMaster() {
    if (!masterBinding) return;
    const result = await training.actions.rollbackModelBinding(masterBinding.id);
    onToast(result ? "Master rolled back to its recorded predecessor." : "Couldn’t roll back Master.", result ? "success" : "error");
  }

  if (selectedEntry) {
    return <ComparisonReleaseDetail
      detail={detail}
      entry={selectedEntry}
      entries={entries}
      masterEntry={masterEntry}
      onBack={() => onSelectedEntryIdChange(null)}
      onOpenEvaluation={onOpenEvaluation}
      onOpenRun={onOpenRun}
      onOpenTaskset={onOpenTaskset}
      onOpenVersion={onOpenVersion}
      series={series}
      state={state}
    />;
  }

  return (
    <div className="labs-flat-body labs-resource-page labs-comparison-series-detail" data-profile-id={state.profileId}>
      <div className="labs-dataset-detail-heading">
        <button aria-label="Back to Comparison Series" className="labs-back-button" type="button" onClick={onBack}><ArrowLeft size={15} /></button>
        <div><h1>{series.name}</h1><p>{project?.name ?? series.modelProjectId} · revision {series.revision}</p></div>
        <LabStatusBadge label={series.status} value={series.status} />
      </div>
      <ModelProjectPageHeader
        title="Series control"
        description={series.objective}
        actions={<div className="labs-comparison-actions">
          <button className="training-button secondary" type="button" onClick={() => onOpenProject(series.modelProjectId)}>Open project</button>
          {!series.scheduleSealedAt ? <button className="training-button" disabled={Boolean(training.busyAction)} type="button" onClick={() => void seal()}>Seal schedule</button> : null}
          {masterBinding?.rollbackTargetBindingId ? <button className="training-button secondary" disabled={Boolean(training.busyAction)} type="button" onClick={() => void rollbackMaster()}>Roll back Master</button> : null}
        </div>}
        metrics={[
          { label: "Master", value: masterEntry?.label ?? "Not set", hint: masterBinding?.id ?? "Production binding is separate" },
          { label: "Experimental head", value: acceptedHead?.label ?? "None", hint: acceptedHead?.modelVersionId ?? "No branch advanced" },
          { label: "Seed", value: acceptedSeed?.label ?? "Pending", hint: `rank ${series.schedule[0]?.trainableRank ?? "—"}` },
          { label: "Capacity", value: `${series.residualProfile.maximumEnabledRank} / ${series.residualProfile.serializedEnvelopeRank}`, hint: "maximum enabled / serialized envelope" },
          { label: "Observed cost", value: `$${seriesCost.toFixed(3)}`, hint: "receipt-backed across materialized releases" },
        ]}
      />
      <section className="training-detail-section">
        <div className="labs-project-trends-heading"><div><h2>Release history</h2><p>Each release opens to its own evidence and lineage page. Only an operator decision can advance a candidate.</p></div><span>{entries.length} of {series.schedule.length} materialized</span></div>
        <div className="training-table-wrap">
          <table className="training-data-table labs-comparison-table">
            <thead><tr><th>Date</th><th>Release</th><th>Branch</th><th>Based on</th><th>Taskset</th><th>New rank</th><th>Candidate stack</th><th>Updates</th><th>Tokens</th><th>GPU time</th><th>Cost</th><th>Status</th><th>Run / Version</th><th>Evaluations</th><th>Operator decision</th><th>Actions</th></tr></thead>
            <tbody>{series.schedule.map((scheduled) => {
              const entry = entryBySchedule.get(scheduled.id) ?? null;
              const evidence = entry ? entryEvidence(state, entry) : null;
              const canPrepare = Boolean(series.scheduleSealedAt && !entry && scheduled.role !== "daily_residual");
              return <tr key={scheduled.id}>
                <td>{entry ? <><strong>{formatDate(entry.createdAt)}</strong><small>{formatTime(entry.createdAt)}</small></> : "—"}</td>
                <td>{entry ? <button className="labs-version-row-button" type="button" onClick={() => onSelectedEntryIdChange(entry.id)}><strong>{entry.label}</strong><small>{roleLabel(entry.role)}</small></button> : <><strong>{scheduled.label}</strong><small>Not materialized</small></>}</td>
                <td>{branchLabel(entry?.role ?? scheduled.role)}</td>
                <td>{entry ? parentLabel(entry, entries) : parentRuleLabel(scheduled.parentRule)}</td>
                <td>{entry ? <button className="labs-version-row-button" type="button" onClick={() => onOpenTaskset(entry.taskset.id)}>{tasksetName(state, entry.taskset.id)}<small>{shortId(entry.taskset.contentHash)}</small></button> : scheduled.taskSource === "nightly_selection" ? "Learning queue" : "Derived on prepare"}</td>
                <td>{entry?.trainableRank ?? scheduled.trainableRank}</td>
                <td>{entry ? <><strong>{entry.enabledCumulativeRank}</strong><small>{candidateStackLabel(entry)}{entry.status === "rejected" || entry.status === "no_signal" ? " · inactive" : ""}</small></> : "—"}</td>
                <td>{evidence ? <>{evidence.progress.committedOptimizerSteps} / {evidence.progress.targetOptimizerSteps}<small>{evidence.progress.skippedOptimizerSteps} skipped</small></> : "Unavailable"}</td>
                <td>{evidence ? formatInteger(evidence.usage.inputTokens + evidence.usage.outputTokens) : "Unavailable"}</td>
                <td>{evidence?.resource.gpuSeconds == null ? "Unavailable" : formatDuration(evidence.resource.gpuSeconds)}</td>
                <td>{evidence?.cost.totalUsd == null ? "Unavailable" : `$${evidence.cost.totalUsd.toFixed(3)}`}</td>
                <td><LabStatusBadge label={comparisonStatusLabel(entry?.status ?? "planned")} value={entry?.status ?? "prepared"} /></td>
                <td>{entry ? <>{entry.modelRunId ? <button className="labs-version-row-button" type="button" onClick={() => onOpenRun(entry.modelProjectId, entry.modelRunId!)}>{shortId(entry.modelRunId)}</button> : "No Run"}{entry.modelVersionId ? <button className="labs-version-row-button" type="button" onClick={() => onOpenVersion(entry.modelProjectId, entry.modelVersionId!)}><small>{shortId(entry.modelVersionId)}</small></button> : <small>No Version</small>}</> : "—"}</td>
                <td>{entry?.evaluations.length ? <button className="labs-version-row-button" type="button" onClick={() => onOpenEvaluation(entry.evaluations[0]!.evaluationRunId)}>{entry.evaluations.length} linked<small>{entry.evaluations.map((evaluation) => evaluation.cohortRole).join(", ")}</small></button> : entry ? "0 linked" : "—"}</td>
                <td>{entry?.decision ? <>{comparisonDecisionLabel(entry.decision.disposition)}<small>{decisionActor(entry.decision.decidedBy)} · {formatDateTime(entry.decision.decidedAt)}</small></> : entry?.status === "no_signal" ? <>No signal<small>No operator decision recorded</small></> : "Awaiting review"}</td>
                <td><div className="labs-comparison-actions">
                  {canPrepare ? <button className="training-button secondary" disabled={Boolean(training.busyAction)} type="button" onClick={() => void queueDerived(scheduled.id)}>Prepare</button> : null}
                  {entry?.status === "ready" ? <button className="training-button" disabled={Boolean(training.busyAction)} type="button" onClick={() => void start(entry)}>Start</button> : null}
                  {entry && ["queued", "running"].includes(entry.status) ? <button className="training-button secondary" disabled={Boolean(training.busyAction)} type="button" onClick={() => void cancel(entry)}>Cancel</button> : null}
                  {entry?.status === "candidate" ? <><button className="training-button" disabled={Boolean(training.busyAction)} type="button" onClick={() => void decide(entry, "advance")}>{entry.role === "seed" || entry.role === "daily_residual" ? "Advance branch" : "Accept candidate"}</button><button className="training-button secondary" disabled={Boolean(training.busyAction)} type="button" onClick={() => void decide(entry, "hold")}>Hold</button></> : null}
                  {entry?.status === "accepted" && entry.modelVersionId ? <button className="training-button secondary" disabled={Boolean(training.busyAction) || masterEntry?.id === entry.id} type="button" onClick={() => void promote(entry)}>{masterEntry?.id === entry.id ? "Master" : "Promote"}</button> : null}
                </div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>
      <LabComparisonQualityTrend entries={entries} onOpenEvaluation={onOpenEvaluation} series={series} state={state} />
      <LabComparisonCurrencyWorkspace entries={entries} onOpenEvaluation={onOpenEvaluation} series={series} state={state} />
    </div>
  );
}

function ComparisonReleaseDetail({ detail, entry, entries, masterEntry, onBack, onOpenEvaluation, onOpenRun, onOpenTaskset, onOpenVersion, series, state }: {
  detail: TrainingRunDetail | null;
  entry: ModelComparisonSeriesEntry;
  entries: ModelComparisonSeriesEntry[];
  masterEntry: ModelComparisonSeriesEntry | null;
  onBack: () => void;
  onOpenEvaluation: (id: string) => void;
  onOpenRun: (projectId: string, runId: string) => void;
  onOpenTaskset: (id: string) => void;
  onOpenVersion: (projectId: string, versionId: string) => void;
  series: ModelComparisonSeries;
  state: TrainingStateResponse;
}) {
  const decision = entry.decision;
  return <div className="labs-flat-body labs-resource-page labs-comparison-series-detail" data-profile-id={state.profileId}>
    <div className="labs-dataset-detail-heading">
      <button aria-label={`Back to ${series.name}`} className="labs-back-button" type="button" onClick={onBack}><ArrowLeft size={15} /></button>
      <div><h1>{entry.label}</h1><p>{series.name} · {roleLabel(entry.role)}</p></div>
      <LabStatusBadge label={comparisonStatusLabel(entry.status)} value={entry.status} />
    </div>
    <ModelProjectPageHeader
      title="Release evidence"
      description="A release is a candidate with immutable training lineage. Advancing it and promoting it to Master are separate operator actions."
      actions={<div className="labs-comparison-actions">
        {entry.modelRunId ? <button className="training-button secondary" type="button" onClick={() => onOpenRun(entry.modelProjectId, entry.modelRunId!)}>Open Run</button> : null}
        {entry.modelVersionId ? <button className="training-button secondary" type="button" onClick={() => onOpenVersion(entry.modelProjectId, entry.modelVersionId!)}>Open Version</button> : null}
        <button className="training-button secondary" type="button" onClick={() => onOpenTaskset(entry.taskset.id)}>Open Taskset</button>
      </div>}
      metrics={[
        { label: "Based on", value: parentLabel(entry, entries), hint: entry.parent.kind === "base_model" ? entry.parent.id : shortId(entry.parent.id) },
        { label: "New rank", value: entry.trainableRank, hint: `block ${shortId(entry.trainableBlockId)}` },
        { label: "Candidate stack", value: entry.enabledCumulativeRank, hint: `${candidateStackLabel(entry)}${entry.status === "rejected" || entry.status === "no_signal" ? " · inactive" : ""}` },
        { label: "Operator decision", value: decision ? comparisonDecisionLabel(decision.disposition) : entry.status === "no_signal" ? "No signal" : "Awaiting review", hint: decision ? `${decisionActor(decision.decidedBy)} · ${formatDateTime(decision.decidedAt)}` : "No operator decision recorded" },
        { label: "Master", value: masterEntry?.id === entry.id ? "Yes" : "No", hint: masterEntry?.id === entry.id ? "Active production binding" : "Promotion is separate from branch advancement" },
      ]}
    />
    {decision ? <section className="training-detail-section">
      <div className="labs-project-trends-heading"><div><h2>Decision record</h2><p>{decision.summary}</p></div><span>{decisionActor(decision.decidedBy)}</span></div>
      <div className="labs-overview-decision-grid">
        <CompactDecisionFact label="Disposition" value={comparisonDecisionLabel(decision.disposition)} />
        <CompactDecisionFact label="Decided by" value={decisionActor(decision.decidedBy)} />
        <CompactDecisionFact label="Decided at" value={formatDateTime(decision.decidedAt)} />
        <CompactDecisionFact label="Policy" value={`${decision.policy.id} v${decision.policy.version}`} />
      </div>
      <div className="labs-comparison-lineage"><strong>Recorded reasons</strong><span>{decision.reasonCodes.join(" · ")}</span></div>
    </section> : null}
    <ComparisonEvidence entry={entry} detail={detail} state={state} onOpenEvaluation={onOpenEvaluation} onOpenTaskset={onOpenTaskset} onOpenVersion={onOpenVersion} />
  </div>;
}

function CompactDecisionFact({ label, value }: { label: string; value: string }) {
  return <div className="labs-overview-decision-card"><small>{label}</small><strong>{value}</strong></div>;
}

function ComparisonEvidence({ entry, detail, onOpenEvaluation, onOpenTaskset, onOpenVersion, state }: { entry: ModelComparisonSeriesEntry | null; detail: TrainingRunDetail | null; onOpenEvaluation: (id: string) => void; onOpenTaskset: (id: string) => void; onOpenVersion: (projectId: string, versionId: string) => void; state: TrainingStateResponse }) {
  if (!entry) return <section className="training-detail-section"><h2>Comparison workspace</h2><div className="training-run-placeholder">Select or materialize a release to inspect evidence.</div></section>;
  const metric = detail?.policyMetrics.at(-1) ?? null;
  const evaluation = detail?.evaluation ?? null;
  const progress = detail?.managedEvidence?.progress ?? null;
  const reward = detail?.managedEvidence?.reward ?? null;
  const cost = detail?.managedEvidence?.cost.totalUsd ?? metric?.costUsd ?? null;
  return <section className="training-detail-section labs-comparison-evidence">
    <div className="labs-project-trends-heading"><div><h2>Comparison workspace · {entry.label}</h2><p>Missing evidence stays unavailable; it is never rendered as zero.</p></div><button className="training-button secondary" type="button" onClick={() => onOpenTaskset(entry.taskset.id)}>Inspect tasks</button></div>
    <div className="labs-comparison-evidence-grid">
      <EvidenceCard title="Outcome" rows={[
        ["Parent score", formatMetric(evaluation?.base.meanScore ?? null)],
        ["Candidate score", formatMetric(evaluation?.trained.meanScore ?? null)],
        ["Score delta", formatSigned(evaluation?.meanScoreDelta ?? null)],
        ["Regressed examples", evaluation ? String(evaluation.examples.filter((example) => (example.trainedGrade?.score ?? 0) < (example.baseGrade?.score ?? 0)).length) : "Unavailable"],
      ]} />
      <EvidenceCard title="Reward signal" rows={[
        ["Mean reward", formatMetric(metric?.meanReward ?? reward?.finalMean ?? null)],
        ["Reward variance", formatMetric(reward?.variance ?? null)],
        ["Distinct rewards", reward ? String(reward.distinctValueCount) : "Unavailable"],
        ["No-signal groups", reward ? String(reward.noSignalGroupCount) : "Unavailable"],
        ["Eligible trajectories", reward ? String(reward.eligibleTrajectoryCount) : "Unavailable"],
        ["Total trajectories", reward ? String(reward.trajectoryCount) : formatMetric(metric?.trajectoryCount ?? null, 0)],
        ["Optimizer updates", progress ? `${progress.committedOptimizerSteps} applied / ${progress.skippedOptimizerSteps} skipped` : "Unavailable"],
      ]} />
      <EvidenceCard title="Movement" rows={[
        ["Policy KL", formatMetric(metric?.kl ?? null)],
        ["Pre-update behavior KL", formatMetric(metric?.behaviorPolicyKlPreUpdate ?? null)],
        ["Policy loss", formatMetric(metric?.policyLoss ?? null)],
        ["Gradient norm", formatMetric(metric?.gradientNorm ?? null)],
        ["Clip fraction", formatMetric(metric?.policyClipFraction ?? null)],
        ["Adapter delta norm", formatMetric(detail?.managedEvidence?.movement.adapterDeltaNorm ?? null)],
      ]} />
      <EvidenceCard title="Efficiency" rows={[
        ["Input tokens", formatMetric(metric?.inputTokens ?? null, 0)],
        ["Output tokens", formatMetric(metric?.outputTokens ?? null, 0)],
        ["Environment executions", formatMetric(metric?.environmentExecutions ?? null, 0)],
        ["Duration", detail?.managedEvidence?.resource.durationSeconds == null ? "Unavailable" : formatDuration(detail.managedEvidence.resource.durationSeconds)],
        ["GPU time", detail?.managedEvidence?.resource.gpuSeconds == null ? "Unavailable" : formatDuration(detail.managedEvidence.resource.gpuSeconds)],
        ["Observed cost", cost === null ? "Unavailable" : `$${cost.toFixed(3)}`],
      ]} />
    </div>
    <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Task</th><th>Parent</th><th>Candidate</th><th>Delta</th><th>Outcome</th></tr></thead><tbody>
      {evaluation?.examples.length ? evaluation.examples.map((example) => {
        const parent = example.baseGrade?.score ?? null;
        const candidate = example.trainedGrade?.score ?? null;
        return <tr key={example.taskId}><td>{example.taskId}</td><td>{formatMetric(parent)}</td><td>{formatMetric(candidate)}</td><td>{parent === null || candidate === null ? "Unavailable" : formatSigned(candidate - parent)}</td><td>{example.trainedGrade?.status ?? "Unavailable"}</td></tr>;
      }) : <tr><td colSpan={5}>Task-level comparison evidence is unavailable for this release.</td></tr>}
    </tbody></table></div>
    {entry.evaluations.length ? <div className="labs-comparison-lineage"><strong>Canonical Evaluation history</strong>{entry.evaluations.map((evaluation) => <button className="labs-version-row-button" key={evaluation.evaluationRunId} type="button" onClick={() => onOpenEvaluation(evaluation.evaluationRunId)}>{evaluation.cohortRole}<small>{shortId(evaluation.evaluationRunId)} · {shortId(evaluation.taskset.contentHash)}</small></button>)}</div> : null}
    {entry.modelVersionId ? <div className="labs-comparison-lineage"><strong>Model Version</strong><button className="labs-version-row-button" type="button" onClick={() => onOpenVersion(entry.modelProjectId, entry.modelVersionId!)}>{shortId(entry.modelVersionId)}</button></div> : null}
    <div className="labs-comparison-lineage"><strong>Immutable lineage</strong><span>{entry.residualBlocks.map((block) => `${block.optimizationRole === "trainable" ? "train" : "frozen"} r${block.rank} [${block.offsetStart},${block.offsetEnd})`).join(" → ")}</span><small>{state.modelVersions.find((version) => version.id === entry.modelVersionId)?.artifactLineageId ?? "Artifact lineage unavailable"}</small></div>
  </section>;
}

function EvidenceCard({ rows, title }: { rows: Array<[string, string]>; title: string }) {
  return <article className="labs-resource-card"><header><strong>{title}</strong></header><dl className="labs-comparison-evidence-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></article>;
}

function tasksetName(state: TrainingStateResponse, id: string) { return [...state.tasksets, ...state.modelTasksets].find((taskset) => taskset.id === id)?.name ?? id; }
function parentLabel(entry: ModelComparisonSeriesEntry, entries: ModelComparisonSeriesEntry[]) { return entry.parent.kind === "base_model" ? "Frozen base" : entries.find((candidate) => candidate.modelVersionId === entry.parent.id)?.label ?? shortId(entry.parent.id); }
function candidateStackLabel(entry: ModelComparisonSeriesEntry) { return entry.residualBlocks.map((block) => `${block.optimizationRole === "trainable" ? "new" : "frozen"} r${block.rank}`).join(" + "); }
function decisionActor(value: string) { return value === "default" ? "Default operator profile" : value; }
function comparisonStatusLabel(status: string) {
  if (status === "accepted") return "Advanced";
  if (status === "rejected") return "Held";
  if (status === "candidate") return "Awaiting decision";
  if (status === "no_signal") return "No signal";
  return status.replaceAll("_", " ");
}
function comparisonDecisionLabel(disposition: "advance" | "hold" | "no_signal") {
  return disposition === "advance" ? "Advanced" : disposition === "hold" ? "Held" : "No signal";
}
function parentRuleLabel(rule: string) {
  if (rule === "base_model") return "Frozen base";
  if (rule === "previous_release") return "Previous release";
  if (rule === "seed_release") return "Seed release";
  if (rule === "accepted_seed") return "Accepted seed";
  return "Accepted daily head";
}
function branchLabel(role: string) { return role === "rank_candidate" ? "Rank candidate" : role === "weekly_rollup" ? "Weekly roll-up" : role === "full_refresh" ? "Full-task refresh" : "Daily"; }
function roleLabel(role: string) { return role === "rank_candidate" ? "controlled rank candidate" : role === "full_refresh" ? "full-task refresh" : role.replaceAll("_", " "); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function formatMetric(value: number | null, digits = 3) { return value === null ? "Unavailable" : value.toFixed(digits); }
function formatSigned(value: number | null) { return value === null ? "Unavailable" : `${value > 0 ? "+" : ""}${value.toFixed(3)}`; }
function formatInteger(value: number) { return new Intl.NumberFormat().format(value); }
function formatDuration(seconds: number) { return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`; }
function shortId(value: string) { return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function entryEvidence(state: TrainingStateResponse, entry: ModelComparisonSeriesEntry): ManagedTrainingRunEvidence | null {
  const job = state.jobs.find((candidate) => candidate.metadata.modelRunId === entry.modelRunId);
  return ManagedTrainingRunEvidenceSchema.safeParse(job?.metadata.managedTrainingEvidence).data ?? null;
}
