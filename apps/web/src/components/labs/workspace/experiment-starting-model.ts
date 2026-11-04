import {
  canonicalJson,
  type ExperimentDraft,
  type ExperimentStartingModel,
} from "openpond-sdk/training";

/** Stored authoring refs retain intent; current catalog reads resolve links. */
export function initialExperimentStartingModel(
  draft: ExperimentDraft | null,
): ExperimentStartingModel | null {
  if (draft?.startingModel) return draft.startingModel;
  const base =
    draft?.alphaEditForm?.baseModel ??
    draft?.neuronTrainingForm?.baseModel ??
    draft?.decisionForm?.baseModel ??
    draft?.engramForm?.baseModel ??
    draft?.activationForm?.baseModel ??
    draft?.trainingForm?.baseModel ??
    draft?.training?.baseModel;
  if (base && draft?.alphaEditForm?.startingModule)
    return {
      source: "alphaedit",
      label: `Saved AlphaEdit matrices · ${draft.alphaEditForm.startingModule.modelProjectId}`,
      inferenceModelId: null,
      baseModel: base,
      alphaedit: draft.alphaEditForm.startingModule,
    };
  if (base && draft?.decisionForm?.startingDecision)
    return {
      source: "decision",
      label: `Saved Decision Model · ${draft.decisionForm.startingDecision.modelProjectId}`,
      inferenceModelId: null,
      baseModel: base,
      decision: draft.decisionForm.startingDecision,
    };
  if (base && draft?.engramForm?.startingModule)
    return {
      source: "engram",
      label: `Saved memory module · ${draft.engramForm.startingModule.modelProjectId}`,
      inferenceModelId: null,
      baseModel: base,
      engram: draft.engramForm.startingModule,
    };
  if (base)
    return {
      source: "managed",
      label: draft?.trainingForm?.startingModelLabel ?? base.modelId,
      baseModel: base,
      inferenceModelId: null,
    };
  const id = draft?.evaluationForm?.form.modelId;
  return id ? { source: "inference", label: id, inferenceModelId: id, baseModel: null } : null;
}
export function experimentModelSourceKey(model: ExperimentStartingModel | null) {
  return model
    ? canonicalJson(
        model.source === "alphaedit"
          ? [model.source, model.alphaedit, model.baseModel]
          : model.source === "neuron_training"
            ? [model.source, model.neuronTraining, model.baseModel]
            : model.source === "decision"
              ? [model.source, model.decision, model.baseModel]
              : model.source === "engram"
                ? [model.source, model.engram, model.baseModel]
                : model.source === "steering"
                  ? [model.source, model.steering, model.baseModel]
                  : model.source === "trained"
                    ? [model.source, model.trainedVersion.contentHash]
                    : model.source === "managed"
                      ? [model.source, model.baseModel]
                      : [model.source, model.inferenceModelId, model.baseModel],
      )
    : "";
}
