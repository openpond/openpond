import type { Taskset, TrainingStateResponse } from "@openpond/contracts";

import { Boxes, Plus } from "../icons";

export function TrainingDatasetStep({
  state,
  selectedTasksetId,
  busy,
  onChange,
  onContinue,
  onCreateDataset,
}: {
  state: TrainingStateResponse | null;
  selectedTasksetId: string | null;
  busy: boolean;
  onChange: (tasksetId: string) => void;
  onContinue: () => void;
  onCreateDataset?: () => void;
}) {
  const datasets = availableDatasets(state);
  const selected = datasets.find((taskset) => taskset.id === selectedTasksetId) ?? null;

  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>Choose a Dataset</h3>
          <p>Use an approved Dataset as the immutable training and Eval boundary for this Model.</p>
        </div>
        <div
          className="training-existing-dataset-list"
          role="radiogroup"
          aria-label="Available Datasets"
        >
          {datasets.map((taskset) => {
            const checked = taskset.id === selectedTasksetId;
            return (
              <button
                aria-checked={checked}
                className={checked ? "selected" : undefined}
                key={taskset.id}
                role="radio"
                type="button"
                onClick={() => onChange(taskset.id)}
              >
                <span className="training-existing-dataset-icon">
                  <Boxes size={17} />
                </span>
                <span>
                  <strong>{taskset.name}</strong>
                  <small>{taskset.objective}</small>
                </span>
                <DatasetSplitSummary state={state} taskset={taskset} />
                <span className="training-choice-indicator" aria-hidden="true" />
              </button>
            );
          })}
          {!datasets.length ? (
            <div className="training-empty training-existing-dataset-empty">
              <strong>No reusable Datasets are ready yet.</strong>
              <span>Create a Dataset, then return here to configure the Model.</span>
            </div>
          ) : null}
        </div>
        {selected ? (
          <p className="training-existing-dataset-note">
            The Dataset remains reusable and unchanged. Creating the Model stores the preferred base Model on the Model draft.
          </p>
        ) : null}
      </div>
      <div className="training-dialog-actions">
        {onCreateDataset ? (
          <button
            className="training-button secondary"
            type="button"
            onClick={onCreateDataset}
          >
            <Plus size={14} />
            Create new Dataset
          </button>
        ) : null}
        <button
          className="training-button"
          disabled={!selected || busy}
          type="button"
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </>
  );
}

function DatasetSplitSummary({
  state,
  taskset,
}: {
  state: TrainingStateResponse | null;
  taskset: Taskset;
}) {
  return (
    <span className="training-existing-dataset-splits">
      <span>{splitCount(state, taskset, "train")} train</span>
      <span>{splitCount(state, taskset, "validation")} validation</span>
      <span>{splitCount(state, taskset, "frozen_eval")} frozen Eval</span>
    </span>
  );
}

function splitCount(
  state: TrainingStateResponse | null,
  taskset: Taskset,
  split: Taskset["tasks"][number]["split"],
): number {
  const artifact = taskset.datasetArtifact
    ? state?.datasetArtifacts?.find(
        (candidate) =>
          candidate.tasksetId === taskset.id
          && candidate.tasksetRevision === taskset.revision,
      )
    : null;
  if (artifact) return artifact.splitCounts[split] ?? 0;
  return taskset.tasks.filter((task) => task.split === split).length;
}

function availableDatasets(
  state: TrainingStateResponse | null,
): Taskset[] {
  if (!state) return [];
  return state.tasksets
    .filter((taskset) => taskset.readiness?.ready)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.name.localeCompare(right.name),
    );
}
