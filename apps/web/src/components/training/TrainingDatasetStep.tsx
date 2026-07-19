import type { Taskset, TrainingStateResponse } from "@openpond/contracts";

import { Boxes } from "../icons";

export function TrainingDatasetStep({
  state,
  selectedTasksetId,
  busy,
  onChange,
  onCreate,
}: {
  state: TrainingStateResponse | null;
  selectedTasksetId: string | null;
  busy: boolean;
  onChange: (tasksetId: string) => void;
  onCreate: () => void;
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
                <DatasetSplitSummary taskset={taskset} />
                <span className="training-choice-indicator" aria-hidden="true" />
              </button>
            );
          })}
          {!datasets.length ? (
            <div className="training-empty training-existing-dataset-empty">
              No reusable Datasets are ready yet. Create a Dataset from the Lab menu, then return here.
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
        <button
          className="training-button"
          disabled={!selected || busy}
          type="button"
          onClick={onCreate}
        >
          Create model
        </button>
      </div>
    </>
  );
}

function DatasetSplitSummary({ taskset }: { taskset: Taskset }) {
  return (
    <span className="training-existing-dataset-splits">
      <span>{splitCount(taskset, "train")} train</span>
      <span>{splitCount(taskset, "validation")} validation</span>
      <span>{splitCount(taskset, "frozen_eval")} frozen Eval</span>
    </span>
  );
}

function splitCount(
  taskset: Taskset,
  split: Taskset["tasks"][number]["split"],
): number {
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
