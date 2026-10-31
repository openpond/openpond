import type { TaskDataRecord } from "@openpond/contracts";
import { captureClientName } from "../../fix-it/client";
import { readCapturedToolError } from "./captured-tool-error";
import { EvaluationCard, EvaluationTime } from "./EvaluationPresentation";

export function DatasetTaskInspector({ task }: { task: TaskDataRecord }) {
  const capture = readCapturedToolError(task.metadata.toolCapture);
  if (!capture) return <>
    <EvaluationCard title="Input"><pre>{JSON.stringify(task.input, null, 2)}</pre></EvaluationCard>
    <EvaluationCard title="Task details"><pre>{JSON.stringify(task, null, 2)}</pre></EvaluationCard>
  </>;
  const failure = capture.failure.payload;
  return <>
    <EvaluationCard title="Captured tool error">
      <dl className="evaluation-workspace-meta">
        <dt>Agent</dt><dd>{captureClientName(capture.client)}</dd>
        <dt>Tool</dt><dd>{capture.attempt.payload.tool.name}</dd>
        <dt>Captured</dt><dd><EvaluationTime value={capture.capturedAt} /></dd>
        <dt>Execution</dt><dd>{failure.execution.replaceAll("_", " ")}</dd>
        {failure.exitCode !== null ? <><dt>Exit code</dt><dd>{failure.exitCode}</dd></> : null}
        <dt>Training permission</dt><dd>{capture.trainingUseAuthorized ? "Granted" : "Not granted"}</dd>
      </dl>
    </EvaluationCard>
    <EvaluationCard title="Tool action"><pre>{JSON.stringify(capture.attempt.payload.action, null, 2)}</pre></EvaluationCard>
    <EvaluationCard title="Error"><pre>{failure.message}</pre></EvaluationCard>
    <p className="evaluation-meta-line">Saving an error does not activate training. Corrections require separate review.</p>
    <details><summary>Full dataset record</summary><pre>{JSON.stringify(task, null, 2)}</pre></details>
  </>;
}
