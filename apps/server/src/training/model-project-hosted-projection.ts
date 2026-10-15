import type { ModelProject } from "@openpond/contracts";
import {
  HostedModelProjectTrainingSetupSchema,
} from "openpond-sdk/model-projects";

export function hostedModelProjectTrainingSetup(
  trainingSetup: ModelProject["trainingSetup"],
) {
  return HostedModelProjectTrainingSetupSchema.parse(trainingSetup);
}
