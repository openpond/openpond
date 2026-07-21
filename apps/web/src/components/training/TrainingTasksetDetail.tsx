import { useEffect, useRef } from "react";
import { isTrainingSourceRef, type Taskset } from "@openpond/contracts";
import type { useTraining } from "../../hooks/useTraining";
import { Loader2 } from "../icons";

type TrainingController = ReturnType<typeof useTraining>;

export function TrainingTasksetDetail({
  taskset,
  training,
  onOpenChat,
}: {
  taskset: Taskset;
  training: TrainingController;
  onOpenChat: (sessionId: string) => void;
}) {
  const requestedValidationRef = useRef<string | null>(null);
  const readinessCurrent = taskset.readiness?.tasksetHash === taskset.contentHash;
  const trainingExamples = taskset.learningSignals.demonstrations.filter((demonstration) => demonstration.approved).length;
  const evaluationExamples = taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  const method = taskset.readiness?.recommendedMethod && taskset.readiness.recommendedMethod !== "none"
    ? taskset.readiness.recommendedMethod
    : taskset.capabilities.compatibleMethods.find((item) => !["none", "retrieval"].includes(item)) ?? "none";

  useEffect(() => {
    if (readinessCurrent) return;
    const validationKey = `${taskset.id}:${taskset.contentHash}`;
    if (requestedValidationRef.current === validationKey) return;
    requestedValidationRef.current = validationKey;
    void training.actions.readiness(taskset.id);
  }, [readinessCurrent, taskset.contentHash, taskset.id, training.actions]);

  return (
    <>
      <dl className="training-taskset-facts" aria-label="Taskset summary">
        <div><dt>Method</dt><dd>{method.toUpperCase()}</dd></div>
        <div><dt>Training examples</dt><dd>{trainingExamples}</dd></div>
        <div><dt>Test examples</dt><dd>{evaluationExamples}</dd></div>
      </dl>

      <div className="training-taskset-content">
        <section className="training-primary-section">
          {readinessCurrent ? <ReadinessSummary taskset={taskset} /> : (
            <div className="training-validation-pending">
              <Loader2 className="spin" size={15} />
              <span>Checking Taskset…</span>
            </div>
          )}
        </section>

        <section className="training-grader-summary">
          <h3>Evaluation</h3>
          <p>{graderLabel(taskset)}</p>
          <pre><code>{graderPreview(taskset)}</code></pre>
        </section>

        <details className="training-simple-section training-source-details">
          <summary>{taskset.sourceRefs.length} source{taskset.sourceRefs.length === 1 ? "" : "s"}</summary>
          <div className="training-source-list">
            {taskset.sourceRefs.map((source) => (
              <div key={source.id}>
                {isTrainingSourceRef(source) ? (
                  <button className="training-chat-link" type="button" onClick={() => onOpenChat(source.sessionId)}>{source.title}</button>
                ) : (
                  <strong>{source.title}</strong>
                )}
                <span className="training-source-metadata">
                  {isTrainingSourceRef(source) ? (
                    <>
                      <span>{source.turnIds.length} turns</span>
                      <span>{source.consent.scope.replaceAll("_", " ")}</span>
                    </>
                  ) : (
                    <span>{source.kind.replaceAll("_", " ")}</span>
                  )}
                  <span>Privacy {source.secretScanStatus === "passed" && source.piiScanStatus === "passed" ? "passed" : "needs review"}</span>
                </span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </>
  );
}

function ReadinessSummary({ taskset }: { taskset: Taskset }) {
  const readiness = taskset.readiness!;
  return (
    <div className={`training-readiness ${readiness.ready ? "ready" : "blocked"}`}>
      {readiness.ready ? <strong>Ready to train</strong> : null}
      {readiness.blockers.length ? (
        <ul>{readiness.blockers.map((blocker) => <li key={blocker.code}>{friendlyBlocker(blocker.code, blocker.message)}</li>)}</ul>
      ) : null}
    </div>
  );
}

function friendlyBlocker(code: string, fallback: string) {
  const messages: Record<string, string> = {
    sft_demonstrations_missing: "Add another successful chat as a training example.",
    grader_audit_missing: "Review the evaluation setup.",
    grader_audit_stale: "The evaluation setup changed and needs to be checked again.",
    grader_hacking: "The evaluation accepted an adversarial example.",
    environment_leakage: "The evaluation exposed information the model should not see.",
    infrastructure_reward: "The evaluation rewarded an infrastructure failure.",
  };
  return messages[code] ?? fallback;
}

function graderLabel(taskset: Taskset) {
  if (taskset.graders.length > 1) return `${taskset.graders.length} checks combined into one score`;
  const grader = taskset.graders[0]!;
  if (grader.kind === "model_judge") return `Model judge using ${grader.judge.modelId}`;
  if (grader.kind === "human") return `Human review by ${grader.reviewerRole}`;
  if (grader.kind === "custom_verifier") return "Custom deterministic check";
  const labels: Record<string, string> = { content: "Content match", schema: "Schema validation", file: "File validation", diff: "Diff validation", test: "Test suite", runtime_event: "Runtime event check", state: "Expected output match" };
  return labels[grader.kind] ?? grader.label;
}

function graderPreview(taskset: Taskset) {
  const grader = taskset.graders[0]!;
  if (taskset.graders.length > 1) return taskset.graders.map((item) => item.label).join("\n");
  if (grader.kind === "model_judge" || grader.kind === "human") return grader.rubric;
  if (grader.kind === "custom_verifier") return `${grader.module} exports ${grader.exportName}`;
  const fields = Array.isArray(grader.config.fields) ? grader.config.fields.filter((field): field is string => typeof field === "string") : [];
  if (fields.length) return fields.map((field) => `output.${field} === expected.${field}`).join("\n");
  if (grader.kind === "content" && grader.config.operator === "exact_equals") {
    const outputField = typeof grader.config.outputField === "string" ? grader.config.outputField : "text";
    return `output.${outputField} exactly matches the saved expected value`;
  }
  if (grader.kind === "test") return "Run the saved test suite and require a passing result";
  if (grader.kind === "schema") return "Validate the output against the saved schema";
  return grader.label;
}
