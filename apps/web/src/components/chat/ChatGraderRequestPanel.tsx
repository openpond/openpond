import type { ChatResourceSummary } from "@openpond/contracts";
import { modelsLocation, modelsPath } from "../labs/models-route";

const GRADER_TYPES = [
  {
    value: "model_judge",
    label: "LLM judge",
    request: "Create an LLM judge (model_judge) with an explicit rubric and passing and failing calibration examples. Ask for the judge model and a fixture-check spending limit if they are not already agreed.",
  },
  {
    value: "human",
    label: "Human assessment",
    request: "Create a human assessment (human) with a structured review form, explicit criteria, scale anchors and reviewer guidance. Keep human decisions separate from automatic evaluation scores; do not invent reviews or use pending reviews as training rewards.",
  },
  {
    value: "custom_verifier",
    label: "Code grader",
    request: "Create a code grader (custom_verifier) using an isolated JavaScript verifier. Include known-good, known-bad and boundary fixtures, and check them before reporting the grader as validated.",
  },
  {
    value: "python_correctness",
    label: "Python correctness",
    request: "Create a Python correctness grader using the supported Python correctness starter and private tests. Verify that the dataset contains admitted Python code and that a qualified isolated runtime is available. Missing code, tests or runtime evidence must remain unscorable.",
  },
] as const;

export function ChatGraderRequestPanel({ dataset, busy, onDraft }: {
  dataset: ChatResourceSummary | null;
  busy: boolean;
  onDraft: (text: string) => void;
}) {
  function submit(type: typeof GRADER_TYPES[number]) {
    if (!dataset || busy) return;
    onDraft(`${type.request}\n\nDataset: ${dataset.name}, ID ${dataset.id}, revision ${dataset.revision}. Inspect its tasks and existing graders to determine the appropriate checks.\n\nPreserve the existing graders and retained experiment inputs. Save changes as a new dataset revision. Do not start an experiment or training run.`);
  }
  return <div className="chat-grader-request">
    <div className="evaluation-dataset-choices chat-grader-type-choices" role="group" aria-label="Grader type">
      {GRADER_TYPES.map(type => <button key={type.value} type="button" className="training-button secondary" disabled={busy || !dataset}
        onClick={() => submit(type)}>{type.label}</button>)}
    </div>
    <div className="training-dialog-actions">
      <a className="training-text-button" href={modelsPath(modelsLocation("graders", null, { area: "console" }))}>Manage graders</a>
    </div>
  </div>;
}
