import { useEffect, useMemo, useState } from "react";
import type { Taskset } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import {
  buildTrainingModelChatHandoff,
  type TrainingModelChatHandoff,
} from "../../lib/training-model-chat-handoff";
import { ChevronRight, MessageSquare } from "../icons";
import { TrainingModelDetail } from "./TrainingModelDetail";
import { formatDateTime, trainingModelRows } from "./training-model-data";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingModels({
  training,
  connection,
  onOpenTasksetFiles,
  onOpenTaskset,
  onSelectedTasksetIdChange,
  onSelectedJobIdChange,
  onChatWithModel,
  onToast,
  detailTasksetId,
  onDetailTasksetIdChange,
}: {
  training: TrainingController;
  connection: ClientConnection | null;
  onOpenTasksetFiles: (tasksetId: string) => void;
  onOpenTaskset: (tasksetId: string) => void;
  onSelectedTasksetIdChange: (tasksetId: string) => void;
  onSelectedJobIdChange: (jobId: string | null) => void;
  onChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  onToast: ShowAppToast;
  detailTasksetId: string | null;
  onDetailTasksetIdChange: (tasksetId: string | null) => void;
}) {
  const rows = useMemo(() => trainingModelRows(training.payload), [training.payload]);
  const [deleteTarget, setDeleteTarget] = useState<Taskset | null>(null);
  const selected = rows.find((row) => row.taskset.id === detailTasksetId) ?? null;

  useEffect(() => {
    if (detailTasksetId && !rows.some((row) => row.taskset.id === detailTasksetId)) onDetailTasksetIdChange(null);
  }, [detailTasksetId, onDetailTasksetIdChange, rows]);

  const deleteDialog = deleteTarget ? <div className="training-dialog-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(null)}><section className="training-dialog training-delete-dialog" role="dialog" aria-modal="true" aria-label="Delete model" onMouseDown={(event) => event.stopPropagation()}><div className="training-dialog-header"><h2>Delete model?</h2></div><p>This removes the Taskset, training setup, runs, and locally managed artifacts for {deleteTarget.name}.</p><div className="training-dialog-actions"><button className="training-button secondary" type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="training-button danger" type="button" disabled={Boolean(training.busyAction)} onClick={async () => { const deleted = await training.actions.deleteTaskset(deleteTarget.id); if (deleted) { setDeleteTarget(null); onDetailTasksetIdChange(null); } }}>Delete</button></div></section></div> : null;

  if (selected) return <><TrainingModelDetail key={selected.taskset.id} taskset={selected.taskset} training={training} connection={connection} onDelete={() => setDeleteTarget(selected.taskset)} onOpenTaskset={() => onOpenTaskset(selected.taskset.id)} onOpenTasksetFiles={() => onOpenTasksetFiles(selected.taskset.id)} onSelectedJobIdChange={onSelectedJobIdChange} onToast={onToast}/>{deleteDialog}</>;

  return (
    <div className="training-page-body training-model-list">
      {rows.length ? <div className="training-table-wrap"><table className="training-data-table training-models-table">
        <thead><tr><th>Model</th><th>Primary</th><th>Latest run</th><th>Base model</th><th>Runs</th><th>Updated</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.taskset.id} onClick={() => open(row.taskset.id)}>
          <td><button className="training-model-link" type="button" onClick={(event) => { event.stopPropagation(); open(row.taskset.id); }}><strong>{row.name}</strong><span>{row.taskset.name}</span></button></td>
          <td>{row.primaryMethod.toUpperCase()}</td>
          <td>{row.latestRunLabel}</td>
          <td>{row.latestPlan?.recipe.method === "sft" ? row.latestPlan.recipe.baseModel.id : "Not selected"}</td>
          <td>{row.runCount}</td>
          <td>{formatDateTime(row.updatedAt)}</td>
          <td><span className={`training-run-status ${row.latestJob?.status ?? "ready"}`}>{row.status}</span></td>
          <td><div className="training-table-actions">{row.localModel ? <button className="training-table-chat" type="button" aria-label={`Chat with ${row.name}`} disabled={!row.localModel.promotable} title={row.localModel.promotable ? "Start a bounded chat session with this model" : "Chat is available after a version passes frozen evaluation"} onClick={(event) => { event.stopPropagation(); onChatWithModel(buildTrainingModelChatHandoff({ modelId: row.localModel!.id, taskset: row.taskset })); }}><MessageSquare size={13}/> Chat</button> : null}<ChevronRight size={15}/></div></td>
        </tr>)}</tbody>
      </table></div> : <div className="training-empty-detail"><h2>No models yet</h2><p>Create a Taskset from selected chats to start training.</p></div>}

      {deleteDialog}
    </div>
  );

  function open(tasksetId: string) {
    onDetailTasksetIdChange(tasksetId);
    onSelectedTasksetIdChange(tasksetId);
  }
}
