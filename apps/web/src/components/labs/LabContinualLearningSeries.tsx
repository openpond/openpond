import { useMemo } from "react";
import type { TrainingStateResponse } from "@openpond/contracts";

import { LabStatusBadge } from "./LabStatusBadge";

export function LabContinualLearningSeries({
  modelProjectId,
  onOpenRun,
  onOpenSeries,
  state,
}: {
  modelProjectId: string | null;
  onOpenRun: (runId: string) => void;
  onOpenSeries: (seriesId: string) => void;
  state: TrainingStateResponse | null;
}) {
  const series = useMemo(() => state?.comparisonSeries
    .filter((candidate) => candidate.modelProjectId === modelProjectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) ?? [], [modelProjectId, state]);
  if (!series.length || !state) return null;
  return <section className="training-detail-section labs-continual-series">
    <div className="labs-project-trends-heading"><div><h2>Continual Series</h2><p>Saved schedules, accepted experimental heads, Master bindings, and exact release lineage.</p></div><span>{series.length} series</span></div>
    {series.map((item) => {
      const entries = state.comparisonSeriesEntries.filter((entry) => entry.seriesId === item.id).sort((left, right) => left.ordinal - right.ordinal);
      const accepted = entries.find((entry) => entry.id === item.acceptedDailyHeadEntryId) ?? null;
      const binding = state.modelBindings.find((candidate) => candidate.status === "active" && candidate.profileId === item.profileId && candidate.role === item.productionBinding.role && candidate.roleTargetId === item.productionBinding.roleTargetId) ?? null;
      const master = binding ? entries.find((entry) => state.modelVersions.find((version) => version.id === entry.modelVersionId)?.artifactLineageId === binding.modelArtifactLineageId) ?? null : null;
      return <article className="labs-resource-card" key={item.id}>
        <header><div><strong>{item.name}</strong><small>{item.schedule.length} planned releases · updated {formatDate(item.updatedAt)}</small></div><div className="labs-comparison-actions"><LabStatusBadge label={item.status} value={item.status} /><button className="training-button secondary" type="button" onClick={() => onOpenSeries(item.id)}>Open series</button></div></header>
        <div className="labs-overview-decision-grid">
          <CompactFact label="Master" value={master?.label ?? "Not set"} />
          <CompactFact label="Accepted head" value={accepted?.label ?? "None"} />
          <CompactFact label="Current release" value={entries.at(-1)?.label ?? "Not started"} />
          <CompactFact label="Capacity" value={`${item.residualProfile.maximumEnabledRank} / ${item.residualProfile.serializedEnvelopeRank}`} />
        </div>
        <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Date</th><th>Release</th><th>Role</th><th>Rank</th><th>Status</th><th>Run</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{formatDate(entry.createdAt)}</td><td><strong>{entry.label}</strong></td><td>{entry.role.replaceAll("_", " ")}</td><td>{entry.trainableRank}<small>{entry.enabledCumulativeRank} enabled</small></td><td><LabStatusBadge label={entry.status} value={entry.status} /></td><td>{entry.modelRunId ? <button className="labs-version-row-button" type="button" onClick={() => onOpenRun(entry.modelRunId!)}>{shortId(entry.modelRunId)}</button> : "—"}</td></tr>)}</tbody></table></div>
      </article>;
    })}
  </section>;
}

function CompactFact({ label, value }: { label: string; value: string }) { return <div className="labs-overview-decision-card"><small>{label}</small><strong>{value}</strong></div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value)); }
function shortId(value: string) { return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
