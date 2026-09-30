import { useRef, useState } from "react";
import { feedbackKeyForReward, learningRef, type RewardRelease } from "openpond-sdk/learning";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import { WorkspacePanel } from "./WorkspacePanel";
import { GraderReleasePicker } from "./GraderReleasePicker";
import type { WorkspaceApi } from "./workspace-api";
export function DatasetGraders({ api, dataset, readOnly, onSaved }: { api: WorkspaceApi; dataset: DatasetWorkspaceReceipt; readOnly: boolean; onSaved: () => void }) {
  const [picking, setPicking] = useState(false);
  const [reward, setReward] = useState<RewardRelease | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function change(removeId?: string) {
    if (active.current) return; active.current = true; setBusy(true); setError(null);
    try {
      const value = { id: dataset.datasetId, expectedRevision: dataset.revision, release: removeId ? null : reward ? learningRef(reward) : null, ...(removeId ? { removeId } : {}) };
      const operation = api.operation("attachDatasetGrader", value);
      await api.request("attachDatasetGrader", { ...value, operationId: operation.id, now: operation.createdAt });
      operation.acknowledge(); setPicking(false); setReward(null); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { active.current = false; setBusy(false); }
  }
  return <section><header className="evaluation-workspace-header"><h2>Attached graders</h2><button className="training-button secondary" disabled={readOnly || busy} onClick={() => setPicking(true)}>Attach released grader</button></header>{readOnly ? <p>These releases are pinned to this published dataset. Create an editable version to change them.</p> : <p>Attachment selects an exact published release. Changes are published with the next dataset version.</p>}{error ? <p role="alert">{error}</p> : null}<table className="training-data-table"><thead><tr><th>Grader</th><th>Release</th><th>Type</th><th /></tr></thead><tbody>{dataset.workspace.draft.graders.map(grader => <tr key={grader.id}><td>{grader.label}</td><td>{grader.id} · {grader.version}</td><td>{grader.kind}</td><td><button className="training-text-button" disabled={readOnly || busy} onClick={() => void change(grader.id)}>Remove attachment</button></td></tr>)}</tbody></table>{picking ? <WorkspacePanel label="Dataset grader attachment"><header><h2>Attach grader</h2><button disabled={busy} onClick={() => setPicking(false)}>Close</button></header><GraderReleasePicker api={api} value={reward} onChange={setReward} /><p>{reward ? `Save ${reward.name} (${feedbackKeyForReward(reward)}) revision ${reward.revision} to this editable dataset.` : "Choose a published grader and its exact release."}</p><button className="training-button" disabled={busy || !reward} onClick={() => void change()}>{busy ? "Saving attachment…" : "Attach release"}</button></WorkspacePanel> : null}</section>;
}
