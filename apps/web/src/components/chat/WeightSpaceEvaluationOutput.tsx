import type { WeightSpaceCommandResult } from "openpond-sdk/training";

type Output = NonNullable<WeightSpaceCommandResult["evaluation"]>["rows"][number];

export function WeightSpaceEvaluationOutput({ label, output }: { label: string; output: Output }) {
  return <>
    <h4>{label}{output.reachedTokenLimit ? " · output limit reached" : ""}</h4>
    <pre className="saved-model-version-reference">{output.outputText}</pre>
  </>;
}
