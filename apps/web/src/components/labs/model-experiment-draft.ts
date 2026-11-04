import { type ModelProject, type TrainingStateResponse } from "@openpond/contracts";
import {
  createModelTrainingRecipeDefaults,
  rebindModelTrainingRecipe,
} from "openpond-sdk/model-starters";
import { ModelProjectRecipeDocumentSchema } from "openpond-sdk/model-projects";
import {
  ExperimentDraftSchema,
  newAlphaEditExperimentForm,
  alphaEditFormFromModelVersion,
  experimentStartingModelFromAlphaEditVersion,
  TrainingPreparationParentSchema,
  type ExperimentDraft,
  type SavedModelVersion,
  decisionFormFromModelVersion,
  experimentStartingModelFromDecisionVersion,
  engramFormFromModelVersion,
  experimentStartingModelFromEngramVersion,
  activationFormFromSteeringVersion,
  experimentStartingModelFromSteeringVersion,
  parseAndVerifySavedModelVersion,
} from "openpond-sdk/training";
import { initialDecisionForm } from "./workspace/decision-form-defaults";
import { initialEngramForm } from "./workspace/engram-form-defaults";
import { initialActivationForm } from "./workspace/activation-form-defaults";
import type { LabModelVersion } from "./lab-models";

/** Source metadata seeds authoring only. Preparation reauthorizes the exact
 * checkpoint and the selected runtime; no display label grants execution. */
export async function modelExperimentDraft(input: {
  project: ModelProject;
  version: LabModelVersion | null;
  state: TrainingStateResponse;
  teamId: string;
  savedVersion?: SavedModelVersion | null;
}): Promise<ExperimentDraft> {
  const { project, version } = input;
  const saved = input.savedVersion
    ? await parseAndVerifySavedModelVersion(input.savedVersion, {
        teamId: input.teamId,
        modelProjectId: project.hosted?.projectId,
      })
    : null;
  if (saved && saved.portableProjectId !== project.id)
    throw new Error("The saved version belongs to another Model.");
  if (saved?.schemaVersion === "openpond.alphaEditModelVersion.v1")
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: crypto.randomUUID(),
      operationType: "alphaedit",
      name: `${project.name} AlphaEdit experiment`,
      startingModel: await experimentStartingModelFromAlphaEditVersion(saved, {
        teamId: input.teamId,
        label: `${project.name} / Saved AlphaEdit matrices`,
      }),
      alphaEditForm: await alphaEditFormFromModelVersion(newAlphaEditExperimentForm(), saved, {
        teamId: input.teamId,
      }),
    });
  if (saved?.schemaVersion === "openpond.neuronTrainingModelVersion.v1")
    throw new Error(
      "This saved neuron delta supports inference. Training continuation is unavailable because optimizer state is not retained. Choose a managed base explicitly for a fresh experiment.",
    );
  if (saved?.schemaVersion === "openpond.decisionModelVersion.v1")
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: crypto.randomUUID(),
      operationType: "decision_model",
      name: `${project.name} Decision experiment`,
      startingModel: await experimentStartingModelFromDecisionVersion(saved, {
        teamId: input.teamId,
        label: `${project.name} / Saved Decision adapter`,
      }),
      decisionForm: await decisionFormFromModelVersion(initialDecisionForm("score"), saved, {
        teamId: input.teamId,
      }),
    });
  if (saved?.schemaVersion === "openpond.engramModelVersion.v1")
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: crypto.randomUUID(),
      operationType: "engram_adapter",
      name: `${project.name} Engram experiment`,
      startingModel: await experimentStartingModelFromEngramVersion(saved, {
        teamId: input.teamId,
        label: `${project.name} / Saved memory module`,
      }),
      engramForm: await engramFormFromModelVersion(initialEngramForm(), saved, {
        teamId: input.teamId,
      }),
    });
  if (saved?.schemaVersion === "openpond.steeringModelVersion.v1")
    return ExperimentDraftSchema.parse({
      schemaVersion: "openpond.experimentDraft.v1",
      id: crypto.randomUUID(),
      operationType: "neuron_steering",
      name: `${project.name} steering experiment`,
      startingModel: await experimentStartingModelFromSteeringVersion(saved, {
        teamId: input.teamId,
        label: `${project.name} / Saved steering profile`,
      }),
      activationForm: await activationFormFromSteeringVersion(initialActivationForm(), saved, {
        teamId: input.teamId,
      }),
    });
  let base = project.trainingSetup.baseModel ?? project.defaultBaseModel;
  let parent: ReturnType<typeof TrainingPreparationParentSchema.parse> | undefined;
  let evaluation = project.trainingSetup.evaluationTasksetRef ?? null;
  let sourceLabel = version ? `${project.name} / Version ${version.number}` : project.name;
  if (saved) {
    if (
      saved.teamId !== input.teamId ||
      saved.portableProjectId !== project.id ||
      saved.modelProjectId !== project.hosted?.projectId
    )
      throw new Error("The saved checkpoint belongs to another Model or workspace.");
    if (saved.request.recipe.method !== "grpo")
      throw new Error(
        "The current SFT worker cannot continue from a trained checkpoint. Open this version's result for evaluation, or select a base Model for new training.",
      );
    parent = TrainingPreparationParentSchema.parse({
      jobId: saved.jobId,
      artifact: saved.candidate.artifact,
      checkpointId: saved.candidate.checkpointId,
      adapterMode: project.trainingSetup.continuationAdapterMode ?? "residual_append",
    });
    base = saved.request.baseModel;
    evaluation = saved.request.source.evaluation?.taskset ?? null;
    sourceLabel = `${project.name} / Saved checkpoint`;
  } else if (version) {
    throw new Error(
      "Open this Model's canonical saved version before creating an experiment from its trained checkpoint.",
    );
  }
  if (!base?.revision || base.source !== "managed")
    throw new Error("Choose an exact managed base Model before preparing hosted training.");
  const method = parent || project.trainingSetup.method === "grpo" ? "grpo" : "sft";
  const defaults = createModelTrainingRecipeDefaults(project.trainingSetup.recipe, method);
  const { continuation: _oldParent, ...recipe } = ModelProjectRecipeDocumentSchema.parse(
    rebindModelTrainingRecipe(defaults),
  );
  const dataset = recipe.dataset;
  const validationSplit =
    dataset &&
    typeof dataset === "object" &&
    "validationSplit" in dataset &&
    dataset.validationSplit === "frozen_eval"
      ? "frozen_eval"
      : "validation";
  return ExperimentDraftSchema.parse({
    schemaVersion: "openpond.experimentDraft.v1",
    id: crypto.randomUUID(),
    operationType: method,
    name: `${project.name} experiment`,
    trainingForm: {
      baseModel: base,
      recipe,
      batch: null,
      evaluation,
      validationSplit,
      name: `${project.name} experiment`,
      budget:
        project.trainingSetup.preferredMaximumSpendUsd == null
          ? ""
          : String(project.trainingSetup.preferredMaximumSpendUsd),
      gpuSelection: project.trainingSetup.managedGpuSelection,
      ...(parent ? { parent, startingModelLabel: sourceLabel } : {}),
    },
    ...(saved
      ? {
          startingModel: {
            source: "trained",
            label: sourceLabel,
            inferenceModelId: null,
            baseModel: base,
            trainedVersion: saved,
          },
        }
      : {}),
  });
}
