import type { TrainingExecutionStatus } from "@openpond/contracts";

export function shouldCollectPortableTrainingArtifacts(
  state: TrainingExecutionStatus["state"],
): boolean {
  return state === "succeeded";
}
