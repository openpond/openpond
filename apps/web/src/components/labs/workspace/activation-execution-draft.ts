import { ExperimentDraftSchema, type ManagedModificationExecution } from "openpond-sdk/training";

/** The caller supplies its canonical verified execution read. Copy authoring
 * only: no original draft identity, plan, operation or approval is reused. */
export function activationExecutionDraft(
  execution: ManagedModificationExecution,
  owner: {teamId: string; actorId: string | null},
) {
  if (!owner.actorId || execution.teamId !== owner.teamId || execution.ownerUserId !== owner.actorId)
    throw new Error("Copy this execution in its original account and workspace.");
  const form = execution.sourceForm;
  if (!form?.baseModel) throw new Error("This execution has no retained raw settings and exact starting model to copy.");
  return ExperimentDraftSchema.parse({
    schemaVersion: "openpond.experimentDraft.v1", id: crypto.randomUUID(),
    operationType: execution.method, name: execution.name,
    activationForm: form,
    startingModel: form.startingProfile
      ? {source: "steering", label: `Saved steering Model · ${form.startingProfile.modelProjectId}`,
        inferenceModelId: null, baseModel: form.baseModel, steering: form.startingProfile}
      : {source: "managed", label: form.baseModel.modelId, inferenceModelId: null, baseModel: form.baseModel},
  });
}
