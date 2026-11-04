import {
  canonicalSha256,
  ExperimentDraftSchema,
  newNeuronTrainingExperimentForm,
  parseAndVerifyActivationReferenceResult,
  StoredManagedModificationResultReferenceSchema,
  type ManagedModificationExecution,
  type StoredManagedModificationResultReference,
} from "openpond-sdk/training";

export type InspectionCoordinate = { layer: number; neuron: number };
export function inspectionTrainingCoordinates(
  execution: ManagedModificationExecution,
): InspectionCoordinate[] {
  const off = new Set(
    execution.request.variants.filter((row) => row.profile === null).map((row) => row.id),
  );
  const unique = new Map<string, InspectionCoordinate>();
  for (const row of execution.result?.captures ?? [])
    if (off.has(row.variantId))
      unique.set(`${row.layer}:${row.neuron}`, { layer: row.layer, neuron: row.neuron });
  return [...unique.values()].sort((a, b) => a.layer - b.layer || a.neuron - b.neuron);
}
export function inspectionSupportsNeuronTraining(execution: ManagedModificationExecution) {
  const base = execution.sourceForm?.baseModel,
    model = execution.request.model;
  return (
    execution.phase === "completed" &&
    Boolean(execution.result) &&
    base?.source === "managed" &&
    base.modelAssetId === null &&
    base.modelId === model.modelId &&
    base.revision === model.revision &&
    !execution.sourceForm?.startingProfile &&
    model.adapter === null &&
    model.architecture === "dense_decoder" &&
    model.dtype === "bfloat16" &&
    model.quantization === "none"
  );
}
/** Canonical inspection evidence selects observed columns; reviewed training
 * and background data remain required in the ordinary experiment editor. */
export async function neuronTrainingInspectionDraft(
  execution: ManagedModificationExecution,
  selected: InspectionCoordinate[],
  rawReference: StoredManagedModificationResultReference,
) {
  const reference = StoredManagedModificationResultReferenceSchema.parse(rawReference);
  if (
    !inspectionSupportsNeuronTraining(execution) ||
    !execution.result ||
    !execution.sourceForm?.baseModel
  )
    throw new Error(
      "Choose a completed inspection of the exact unmodified dense base before training selected neurons.",
    );
  const result = await parseAndVerifyActivationReferenceResult(execution.result, execution.request);
  if (
    reference.owner.teamId !== execution.teamId ||
    reference.owner.actorId !== execution.ownerUserId ||
    reference.projectId !== execution.projectId ||
    reference.executionId !== execution.id ||
    reference.method !== execution.method ||
    reference.inputHash !== execution.plan.inputHash ||
    reference.runtimeHash !== execution.plan.runtimeHash ||
    reference.resultHash !== result.contentHash
  )
    throw new Error(
      "The selected inspection differs from its original account, Project or retained result.",
    );
  const observed = new Set(
    inspectionTrainingCoordinates(execution).map((row) => `${row.layer}:${row.neuron}`),
  );
  const coordinates = [
    ...new Map(selected.map((row) => [`${row.layer}:${row.neuron}`, row])).values(),
  ].sort((a, b) => a.layer - b.layer || a.neuron - b.neuron);
  if (
    !coordinates.length ||
    coordinates.length > 128 ||
    coordinates.some((row) => !observed.has(`${row.layer}:${row.neuron}`))
  )
    throw new Error(
      "Select between 1 and 128 neurons observed under Off in this exact inspection.",
    );
  const base = execution.sourceForm.baseModel,
    form = newNeuronTrainingExperimentForm(base);
  const name = `Train selected neurons · ${execution.name}`.slice(0, 500);
  return ExperimentDraftSchema.parse({
    schemaVersion: "openpond.experimentDraft.v1",
    id: crypto.randomUUID(),
    operationType: "selective_neuron_training",
    name,
    startingModel: {
      source: "managed",
      label: base.modelId,
      baseModel: base,
      inferenceModelId: null,
    },
    neuronTrainingForm: {
      ...form,
      name,
      selection: {
        ...form.selection,
        count: String(coordinates.length),
        coordinates: coordinates.map((row) => `${row.layer}:${row.neuron}`).join("\n"),
      },
      inspectionSource: {
        result: reference,
        modelHash: await canonicalSha256(execution.request.model),
      },
    },
  });
}
