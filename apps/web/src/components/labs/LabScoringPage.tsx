import { useMemo, useState } from "react";
import type {
  ChatModelRef,
  GraderSpec,
  ProviderSettings,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";

import { ArrowLeft, Search } from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import {
  LabScorerCreateDialog,
  type LabScorerCreateInput,
} from "./LabScorerCreateDialog";

type ScorerEntry = {
  key: string;
  grader: GraderSpec;
  tasksets: Taskset[];
};

export function LabScoringPage({
  busy,
  defaultModel,
  modelProjectId,
  onCreateScorer,
  onOpenTaskset,
  onSelectedScorerIdChange,
  providerSettings,
  selectedScorerId,
  state,
}: {
  busy: boolean;
  defaultModel: ChatModelRef;
  modelProjectId?: string | null;
  onCreateScorer: (input: LabScorerCreateInput) => Promise<boolean>;
  onOpenTaskset: (tasksetId: string) => void;
  onSelectedScorerIdChange: (scorerId: string | null) => void;
  providerSettings: ProviderSettings | null;
  selectedScorerId: string | null;
  state: TrainingStateResponse | null;
}) {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const entries = useMemo(
    () => scoringEntries(state, modelProjectId ?? null),
    [modelProjectId, state],
  );
  const selected = entries.find((entry) => entry.key === selectedScorerId) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const visible = entries.filter((entry) =>
    !normalizedQuery || [
      entry.grader.id,
      entry.grader.label,
      entry.grader.kind,
      entry.grader.version,
    ].some((value) => value.toLowerCase().includes(normalizedQuery)),
  );

  if (selected) {
    return (
      <ScorerDetail
        entry={selected}
        state={state}
        onBack={() => onSelectedScorerIdChange(null)}
        onOpenTaskset={onOpenTaskset}
      />
    );
  }

  const modelJudgeCount = entries.filter(
    (entry) => entry.grader.kind === "model_judge",
  ).length;
  const visibleTasksetIds = new Set(
    entries.flatMap((entry) => entry.tasksets.map((taskset) => taskset.id)),
  );
  const learnedRewardCount = state?.rewardModelVersions.filter((version) =>
    !modelProjectId || visibleTasksetIds.has(version.taskset.id),
  ).length ?? 0;

  return (
    <div className="labs-flat-body labs-resource-page">
      <ModelProjectPageHeader
        actions={(
          <button className="training-button" type="button" onClick={() => setCreateOpen(true)}>
            New scorer
          </button>
        )}
        title="Scoring"
        description={modelProjectId
          ? "Versioned graders and reward sources attached to this Model Project."
          : "Reusable deterministic graders, LLM judges, human rubrics, and learned reward models."}
        metrics={[
          { label: "Scorer releases", value: entries.length },
          { label: "LLM judges", value: modelJudgeCount },
          { label: "Learned reward models", value: learnedRewardCount },
        ]}
      />
      <div className="labs-workproduct-toolbar">
        <label className="labs-search">
          <Search size={14} />
          <input
            aria-label="Search scoring"
            placeholder="Search scorers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr>
              <th>Scorer</th>
              <th>Type</th>
              <th>Version</th>
              <th>Reward</th>
              <th>Calibration</th>
              <th>Tasksets</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr key={entry.key}>
                <td>
                  <button
                    className="labs-version-row-button"
                    type="button"
                    onClick={() => onSelectedScorerIdChange(entry.key)}
                  >
                    <strong>{entry.grader.label}</strong>
                    <small>{entry.grader.id}</small>
                  </button>
                </td>
                <td>{graderKindLabel(entry.grader.kind)}</td>
                <td>{entry.grader.version}</td>
                <td>{entry.grader.rewardEligible ? "Eligible" : "Evidence only"}</td>
                <td>{graderCalibration(entry.grader)}</td>
                <td>{entry.tasksets.length}</td>
              </tr>
            ))}
            {!visible.length ? (
              <tr>
                <td colSpan={6}>
                  <div className="training-run-placeholder">
                    No scorers match this view.
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {createOpen ? (
        <LabScorerCreateDialog
          busy={busy}
          defaultModel={defaultModel}
          providerSettings={providerSettings}
          tasksets={availableTasksets(state, modelProjectId ?? null)}
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            const created = await onCreateScorer(input);
            if (!created) return false;
            setCreateOpen(false);
            onSelectedScorerIdChange(`${input.grader.id}@${input.grader.version}`);
            return true;
          }}
        />
      ) : null}
    </div>
  );
}

function ScorerDetail({
  entry,
  onBack,
  onOpenTaskset,
  state,
}: {
  entry: ScorerEntry;
  onBack: () => void;
  onOpenTaskset: (tasksetId: string) => void;
  state: TrainingStateResponse | null;
}) {
  const { grader } = entry;
  const auditReports = state?.graderAuditReports.filter((report) =>
    entry.tasksets.some((taskset) => taskset.id === report.tasksetId),
  ) ?? [];
  const rewardModelVersions = state?.rewardModelVersions.filter((version) =>
    entry.tasksets.some((taskset) => taskset.id === version.taskset.id),
  ) ?? [];

  return (
    <div className="labs-flat-body labs-resource-page">
      <div className="labs-dataset-detail-heading">
        <button
          aria-label="Back to Scoring"
          className="labs-back-button"
          type="button"
          onClick={onBack}
        >
          <ArrowLeft size={15} />
        </button>
        <div>
          <h1>{grader.label}</h1>
          <p>{graderKindLabel(grader.kind)} · {grader.id}</p>
        </div>
        <div className="labs-dataset-detail-actions">
          <LabStatusBadge
            label={grader.rewardEligible ? "Reward eligible" : "Evidence only"}
            value={grader.rewardEligible ? "ready" : "available"}
          />
          <LabStatusBadge
            label={grader.hardGate ? "Required gate" : "Advisory"}
            value={grader.hardGate ? "ready" : "available"}
          />
        </div>
      </div>
      <div className="labs-scorer-detail-grid">
        <section className="training-detail-section training-detail-section-panel">
          <h2>Scoring contract</h2>
          <dl className="training-configuration-list">
            <Fact label="ID" value={grader.id} />
            <Fact label="Version" value={grader.version} />
            <Fact label="Type" value={graderKindLabel(grader.kind)} />
            <Fact label="Weight" value={String(grader.weight)} />
            <Fact label="Reward eligible" value={grader.rewardEligible ? "Yes" : "No"} />
            <Fact label="Hard gate" value={grader.hardGate ? "Yes" : "No"} />
            <Fact label="Privileged" value={grader.privileged ? "Yes" : "No"} />
            <Fact label="Calibration" value={graderCalibration(grader)} />
            {grader.kind === "model_judge" ? (
              <Fact
                label="Judge model"
                value={`${grader.judge.providerId} · ${grader.judge.modelId}`}
              />
            ) : null}
          </dl>
          {!grader.privileged && "rubric" in grader ? (
            <pre className="labs-resource-code">{grader.rubric}</pre>
          ) : null}
          {!grader.privileged && "config" in grader ? (
            <pre className="labs-resource-code">{JSON.stringify(grader.config, null, 2)}</pre>
          ) : null}
          {!grader.privileged && "module" in grader ? (
            <p className="labs-detail-copy"><code>{grader.module}</code> · {grader.exportName}</p>
          ) : null}
        </section>
        <section className="training-detail-section training-detail-section-panel">
          <h2>Attached Tasksets</h2>
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead><tr><th>Taskset</th><th>Revision</th><th>Purpose</th><th>Tasks</th></tr></thead>
              <tbody>{entry.tasksets.map((taskset) => (
                <tr key={`${taskset.id}:${taskset.revision}`}>
                  <td>
                    <button className="labs-version-row-button" type="button" onClick={() => onOpenTaskset(taskset.id)}>
                      <strong>{taskset.name}</strong>
                      <small>{taskset.id}</small>
                    </button>
                  </td>
                  <td>{taskset.revision}</td>
                  <td>{titleCase(taskset.purpose)}</td>
                  <td>{taskset.tasks.length}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <section className="training-detail-section training-detail-section-panel labs-scorer-evidence-section">
          <h2>Validation evidence</h2>
          <dl className="labs-inline-facts">
            <Fact label="Audit reports" value={String(auditReports.length)} />
            <Fact label="Passed audits" value={String(auditReports.filter((report) => report.passed).length)} />
            <Fact label="Learned reward versions" value={String(rewardModelVersions.length)} />
          </dl>
          {auditReports.length ? (
            <div className="labs-resource-stack">
              {auditReports.map((report) => (
                <article className="labs-resource-card" key={report.id}>
                  <strong>{report.passed ? "Audit passed" : "Audit failed"}</strong>
                  <span>{report.fixtureRefs.length} fixtures · {report.createdAt}</span>
                </article>
              ))}
            </div>
          ) : <p className="labs-detail-copy">No grader audit has been saved for these Taskset releases.</p>}
        </section>
      </div>
    </div>
  );
}

function scoringEntries(
  state: TrainingStateResponse | null,
  modelProjectId: string | null,
): ScorerEntry[] {
  if (!state) return [];
  const tasksets = availableTasksets(state, modelProjectId);
  const entries = new Map<string, ScorerEntry>();
  for (const taskset of tasksets) {
    for (const grader of taskset.graders) {
      const key = scorerKey(grader);
      const entry = entries.get(key);
      if (entry) {
        entry.tasksets.push(taskset);
      } else {
        entries.set(key, { key, grader, tasksets: [taskset] });
      }
    }
  }
  return [...entries.values()].sort((left, right) =>
    left.grader.label.localeCompare(right.grader.label),
  );
}

function availableTasksets(
  state: TrainingStateResponse | null,
  modelProjectId: string | null,
): Taskset[] {
  if (!state) return [];
  const latestById = new Map<string, Taskset>();
  for (const taskset of [...state.tasksets, ...state.modelTasksets]) {
    const current = latestById.get(taskset.id);
    if (!current || taskset.revision > current.revision) latestById.set(taskset.id, taskset);
  }
  let tasksets = [...latestById.values()];
  if (modelProjectId) {
    const project = state.modelProjects.find((candidate) => candidate.id === modelProjectId);
    const attachedIds = new Set(project?.tasksetSyncs.map((sync) => sync.localTasksetId) ?? []);
    tasksets = tasksets.filter((taskset) => attachedIds.has(taskset.id));
  }
  return tasksets.sort((left, right) => left.name.localeCompare(right.name));
}

function scorerKey(grader: GraderSpec): string {
  return `${grader.id}@${grader.version}`;
}

function graderKindLabel(kind: GraderSpec["kind"]): string {
  if (kind === "model_judge") return "LLM judge";
  if (kind === "custom_verifier") return "Custom verifier";
  return titleCase(kind);
}

function graderCalibration(grader: GraderSpec): string {
  if (grader.kind !== "model_judge") return "Not applicable";
  const advisory = grader.metadata.calibrationIsAdvisory === true
    ? " · advisory"
    : "";
  return `${titleCase(grader.calibrationStatus)}${advisory}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
