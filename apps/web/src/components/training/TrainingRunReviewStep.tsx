import type { TaskCreationSnapshot, TrainingSourceRef } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { Loader2 } from "../icons";
import { AgentRecommendationReview } from "../create-improve/AgentRecommendationReview";
import { TrainingRecommendationReview } from "./TrainingRecommendationReview";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingRunReviewStep({
  busy,
  createLabel,
  creation,
  editDataLabel = "Add chats",
  onAddChats,
  onClose,
  onCreateTaskset,
  onCreationChange,
  resourceIntent = "workproduct",
  sources,
  training,
}: {
  busy: boolean;
  createLabel?: string;
  creation: TaskCreationSnapshot;
  editDataLabel?: string;
  onAddChats: () => void;
  onClose: () => void;
  onCreateTaskset: () => void;
  onCreationChange: (creation: TaskCreationSnapshot) => void;
  resourceIntent?: TaskCreationSnapshot["request"]["resourceIntent"];
  sources: TrainingSourceRef[];
  training: TrainingController;
}) {
  const canCreateTaskset = creation.state === "awaiting_materialization_approval";
  const canAddChats = creation.state === "recommendation_ready" && creation.proposal?.diagnosis.trainingEligible === true;
  const isAgent = creation.request.targetIntent.kind === "agent";
  const resolvedCreateLabel = createLabel ?? (isAgent
    ? creation.request.targetIntent.operation === "improve"
      ? "Continue to improvement plan"
      : "Continue to Agent plan"
    : "Create Taskset");

  return (
    <>
      <div className="training-dialog-scroll-body">
        {isAgent ? (
          <AgentRecommendationReview
            creation={creation}
            onCreationChange={onCreationChange}
            sources={sources}
            training={training}
          />
        ) : (
          <TrainingRecommendationReview creation={creation} resourceIntent={resourceIntent} sources={sources} training={training} onCreationChange={onCreationChange} />
        )}
      </div>
      <div className="training-dialog-actions">
        {canAddChats ? <button className="training-button secondary" type="button" disabled={busy} onClick={onAddChats}>{editDataLabel}</button> : null}
        <button className="training-button secondary" type="button" onClick={onClose}>{canCreateTaskset ? "Cancel" : "Done"}</button>
        {canCreateTaskset ? <button className="training-button" type="button" disabled={busy} onClick={onCreateTaskset}>{busy ? <Loader2 className="spin" size={14} /> : null}{resolvedCreateLabel}</button> : null}
      </div>
    </>
  );
}
