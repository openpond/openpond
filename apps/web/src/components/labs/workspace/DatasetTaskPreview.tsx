import type { TaskDataRecord } from "@openpond/contracts";
import { captureClientName } from "../../fix-it/client";
import { readCapturedToolError } from "./captured-tool-error";
import { EvaluationTime } from "./EvaluationPresentation";

export function DatasetTaskPreview({ task }: { task: TaskDataRecord }) {
  const capture = readCapturedToolError(task.metadata.toolCapture);
  if (capture) return <>
    <td><span className="evaluation-cell-text" title={task.id}>{captureClientName(capture.client)} · {capture.attempt.payload.tool.name}</span>
      <small className="evaluation-muted"><EvaluationTime value={capture.capturedAt} /></small></td>
    <td><span className="evaluation-capture-preview" title={capture.failure.payload.message}>{capture.failure.payload.message.trim().split(/\r?\n/).at(-1)}</span></td>
  </>;
  const input = JSON.stringify(task.input);
  return <>
    <td><span className="evaluation-cell-text" title={task.id}>{task.id}</span></td>
    <td><code className="evaluation-cell-text evaluation-task-input" title={input.slice(0, 2000)}>{input.slice(0, 200)}</code></td>
  </>;
}
