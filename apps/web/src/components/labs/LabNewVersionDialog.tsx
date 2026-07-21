import { useMemo, useState } from "react";
import type { Taskset, TrainingStateResponse } from "@openpond/contracts";

import { X } from "../icons";
import { AppDialog } from "../dialogs/AppDialog";

export function LabNewVersionDialog({
  state,
  initialTasksetId,
  checking,
  onClose,
  onCheck,
  onContinue,
  onReview,
}: {
  state: TrainingStateResponse | null;
  initialTasksetId: string | null;
  checking: boolean;
  onClose: () => void;
  onCheck: (tasksetId: string) => Promise<void>;
  onContinue: (selection: {
    taskset: Taskset;
  }) => void;
  onReview: (tasksetId: string) => void;
}) {
  const datasets = useMemo(
    () =>
      (state?.tasksets ?? [])
        .sort((left, right) => {
          if (left.id === initialTasksetId) return -1;
          if (right.id === initialTasksetId) return 1;
          return right.updatedAt.localeCompare(left.updatedAt);
        }),
    [initialTasksetId, state?.tasksets],
  );
  const [tasksetId, setTasksetId] = useState(
    initialTasksetId &&
      datasets.some((taskset) => taskset.id === initialTasksetId)
      ? initialTasksetId
      : datasets[0]?.id ?? "",
  );
  const selected =
    datasets.find((taskset) => taskset.id === tasksetId) ?? null;
  const selectedReady = selected?.readiness?.ready === true;

  return (
    <AppDialog
      ariaLabel="New version"
      className="training-dialog labs-new-version-dialog"
      dismissDisabled={checking}
      onClose={onClose}
    >
        <div className="training-dialog-header">
          <div>
            <h2>New version</h2>
            <p>Choose the immutable Dataset revision. Training setup comes next.</p>
          </div>
          <button aria-label="Close New version" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="labs-new-version-step">
          <span className="labs-new-version-step-number">1</span>
          <div>
            <strong>Dataset</strong>
            <p>Every run keeps the exact selected revision and Eval boundary.</p>
          </div>
        </div>
        <label className="labs-new-version-select">
          <span>Dataset revision</span>
          <select
            value={tasksetId}
            onChange={(event) => setTasksetId(event.target.value)}
          >
            {datasets.map((taskset) => (
              <option key={taskset.id} value={taskset.id}>
                {taskset.name} · revision {taskset.revision}
                {taskset.readiness?.ready ? "" : " · needs review"}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <dl className="labs-inline-facts labs-new-version-dataset-facts">
            <Fact
              label="Training"
              value={String(splitCount(selected, "train"))}
            />
            <Fact
              label="Validation"
              value={String(splitCount(selected, "validation"))}
            />
            <Fact
              label="Frozen Eval"
              value={String(splitCount(selected, "frozen_eval"))}
            />
            <Fact label="Graders" value={String(selected.graders.length)} />
          </dl>
        ) : (
          <div className="training-run-placeholder">
            No Dataset is available. Create a Dataset first.
          </div>
        )}
        {selected && !selectedReady ? (
          <div className="training-banner warning labs-new-version-readiness">
            <strong>This Dataset needs its local checks before training.</strong>
            <p>
              OpenPond verifies the grader, split boundary, and immutable
              artifact before it can prepare a provider export.
            </p>
            <div className="training-dialog-actions">
              <button
                className="training-text-button"
                type="button"
                onClick={() => {
                  onClose();
                  onReview(selected.id);
                }}
              >
                Review Dataset
              </button>
              <button
                className="training-button secondary"
                disabled={checking}
                type="button"
                onClick={() => void onCheck(selected.id)}
              >
                {checking ? "Checking…" : "Run Dataset checks"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="training-dialog-actions">
          <button
            className="training-button secondary"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="training-button"
            disabled={!selectedReady}
            type="button"
            onClick={() => {
              if (selectedReady && selected) {
                onContinue({ taskset: selected });
              }
            }}
          >
            Configure training
          </button>
        </div>
    </AppDialog>
  );
}

function splitCount(
  taskset: Taskset,
  split: Taskset["tasks"][number]["split"],
): number {
  if (taskset.datasetArtifact) {
    return taskset.datasetArtifact.splitCounts[split] ?? 0;
  }
  return taskset.tasks.filter((task) => task.split === split).length;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
