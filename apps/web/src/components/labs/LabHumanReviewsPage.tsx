import type {
  ChatModelRef,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import { ArrowLeft } from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";
import { PreferenceDatasetSummary } from "./LabModelDataset";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import { PreferenceComparisonReview } from "./PreferenceComparisonReview";

export function LabHumanReviewsPage({
  defaultModel,
  onSelectedTasksetIdChange,
  selectedTasksetId,
  state,
  training,
}: {
  defaultModel: ChatModelRef;
  onSelectedTasksetIdChange: (tasksetId: string | null) => void;
  selectedTasksetId: string | null;
  state: TrainingStateResponse | null;
  training: ReturnType<typeof useTraining>;
}) {
  const tasksets = reviewTasksets(state);
  const selected = tasksets.find((taskset) => taskset.id === selectedTasksetId) ?? null;

  if (selected) {
    const policy = tasksetReviewPolicy(selected);
    return (
      <div className="labs-flat-body labs-resource-page labs-human-review-page labs-human-review-detail">
        <div className="labs-dataset-detail-heading">
          <button
            aria-label="Back to Human Review"
            className="labs-back-button"
            type="button"
            onClick={() => onSelectedTasksetIdChange(null)}
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1>{selected.name}</h1>
            <p>Blinded human preference review · Taskset revision {selected.revision}</p>
          </div>
          <LabStatusBadge label="Review queue" value="ready" />
        </div>
        <div className="labs-human-review-workspace">
          <PreferenceComparisonReview
            defaultMinimumSamples={policy.minimumSamples}
            defaultModel={defaultModel}
            defaultRubric={policy.rubric}
            reviewerKey={selected.profileId}
            tasksetId={selected.id}
            training={training}
          />
        </div>
        <div className="labs-human-review-datasets">
          <PreferenceDatasetSummary tasksetId={selected.id} training={training} />
        </div>
      </div>
    );
  }

  return (
    <div className="labs-flat-body labs-resource-page labs-human-review-page">
      <ModelProjectPageHeader
        title="Human Review"
        description="Blinded assignments, preference evidence, and judge-calibration queues across Tasksets."
        metrics={[
          { label: "Reviewable Tasksets", value: tasksets.length },
          { label: "Human graders", value: tasksets.reduce((count, taskset) => count + taskset.graders.filter((grader) => grader.kind === "human").length, 0) },
          { label: "Judge calibrations", value: tasksets.reduce((count, taskset) => count + taskset.graders.filter((grader) => grader.kind === "model_judge").length, 0) },
        ]}
      />
      <section className="training-detail-section labs-human-review-queues">
        <h2>Review queues</h2>
        <p className="labs-detail-copy">
          Open a Taskset queue to rank blinded candidates, materialize preference evidence, and compare an LLM judge with human decisions.
        </p>
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead><tr><th>Taskset</th><th>Review method</th><th>Scorers</th><th>Target</th><th>Revision</th></tr></thead>
            <tbody>
              {tasksets.map((taskset) => {
                const policy = tasksetReviewPolicy(taskset);
                return (
                  <tr key={`${taskset.id}:${taskset.revision}`}>
                    <td>
                      <button
                        className="labs-version-row-button"
                        type="button"
                        onClick={() => onSelectedTasksetIdChange(taskset.id)}
                      >
                        <strong>{taskset.name}</strong>
                        <small>{taskset.objective}</small>
                      </button>
                    </td>
                    <td>{reviewMethod(taskset)}</td>
                    <td>{taskset.graders.length}</td>
                    <td>{policy.minimumSamples} reviews</td>
                    <td>{taskset.revision}</td>
                  </tr>
                );
              })}
              {!tasksets.length ? (
                <tr><td colSpan={5}><div className="training-run-placeholder">No Tasksets currently expose a human-review workflow.</div></td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function reviewTasksets(state: TrainingStateResponse | null): Taskset[] {
  const tasksets = new Map<string, Taskset>();
  for (const taskset of [...(state?.tasksets ?? []), ...(state?.modelTasksets ?? [])]) {
    if (
      taskset.preferenceComparison ||
      taskset.graders.some((grader) => grader.kind === "human" || grader.kind === "model_judge") ||
      taskset.metadata.tasksetReviewPolicy
    ) {
      tasksets.set(`${taskset.id}:${taskset.revision}:${taskset.contentHash}`, taskset);
    }
  }
  return [...tasksets.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function tasksetReviewPolicy(taskset: Taskset): {
  minimumSamples: number;
  rubric: string;
} {
  const stored = taskset.metadata.tasksetReviewPolicy;
  const policy = stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : null;
  const graderRubric = taskset.graders.find(
    (grader) => grader.kind === "model_judge" || grader.kind === "human",
  );
  return {
    minimumSamples: typeof policy?.minimumSamples === "number"
      ? policy.minimumSamples
      : 100,
    rubric: typeof policy?.rubric === "string"
      ? policy.rubric
      : graderRubric && !graderRubric.privileged && "rubric" in graderRubric
        ? graderRubric.rubric
        : "Rank the candidates by overall task quality.",
  };
}

function reviewMethod(taskset: Taskset): string {
  const human = taskset.graders.some((grader) => grader.kind === "human");
  const judge = taskset.graders.some((grader) => grader.kind === "model_judge");
  if (human && judge) return "Human + LLM judge";
  if (human) return "Human rubric";
  if (judge) return "Judge calibration";
  return "Preference comparison";
}
