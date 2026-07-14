import type { TaskCreationSnapshot, TrainingSourceRef } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { Loader2 } from "../icons";
import { TrainingRecommendationReview } from "./TrainingRecommendationReview";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingRunReviewStep({
  busy,
  creation,
  onAddChats,
  onClose,
  onCreateTaskset,
  onCreationChange,
  sources,
  training,
}: {
  busy: boolean;
  creation: TaskCreationSnapshot;
  onAddChats: () => void;
  onClose: () => void;
  onCreateTaskset: () => void;
  onCreationChange: (creation: TaskCreationSnapshot) => void;
  sources: TrainingSourceRef[];
  training: TrainingController;
}) {
  const canCreateTaskset = creation.state === "awaiting_materialization_approval";
  const canAddChats = creation.state === "recommendation_ready" && creation.proposal?.diagnosis.trainingEligible === true;

  return (
    <>
      <div className="training-dialog-scroll-body">
        <TrainingRecommendationReview creation={creation} sources={sources} training={training} onCreationChange={onCreationChange} />
      </div>
      <div className="training-dialog-actions">
        {canAddChats ? <button className="training-button secondary" type="button" disabled={busy} onClick={onAddChats}>Add chats</button> : null}
        <button className="training-button secondary" type="button" onClick={onClose}>{canCreateTaskset ? "Cancel" : "Done"}</button>
        {canCreateTaskset ? <button className="training-button" type="button" disabled={busy} onClick={onCreateTaskset}>{busy ? <Loader2 className="spin" size={14} /> : null}Create Taskset</button> : null}
      </div>
    </>
  );
}
