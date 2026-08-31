import { ModelUseDialog } from "../training/ModelUseDialog";
import type { LabsRouteProps } from "./labs-route-types";

type LabsRouteModelUseDialogProps = {
  versionId: string | null;
  training: LabsRouteProps["training"];
  onClose: () => void;
};

export function LabsRouteModelUseDialog({
  versionId,
  training,
  onClose,
}: LabsRouteModelUseDialogProps) {
  if (!versionId) return null;
  const lineage = training.training.payload?.models.find(
    (candidate) => candidate.id === versionId,
  );
  const taskset = training.training.payload?.tasksets.find(
    (candidate) => candidate.id === lineage?.tasksetId,
  );
  if (!lineage || !taskset) return null;
  return (
    <ModelUseDialog
      lineage={lineage}
      taskset={taskset}
      training={training.training}
      onChat={training.onChatWithModel}
      onClose={onClose}
    />
  );
}
