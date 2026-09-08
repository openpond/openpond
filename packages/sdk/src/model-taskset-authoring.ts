import { contentHash } from "@openpond/harness";
import { createVerifierSetRelease } from "@openpond/evals";
import { learningRef, sameLearningRef, sealLearningContent } from "@openpond/evals/learning";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { ModelTasksetAuthoringOwnerSchema, ModelTasksetDraftPreparationSchema, ModelTasksetDraftRequestSchema, type ModelTasksetDraftPreparation, type ModelTasksetDraftRequest } from "./model-taskset-authoring-contracts.js";
import { assertModelTasksetAuthoring, modelAuthoredTasksetId } from "./model-taskset-authoring-lineage.js";
import { createTasksetPackage, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";

export * from "./model-taskset-authoring-contracts.js";

/** Resolve under an authorized Model CAS. The host retains requestHash and the
 * preparation so retrying cannot choose newer source bytes or another draft. */
export function prepareModelTasksetDraft(input: { request: ModelTasksetDraftRequest; owner: { scopeId: string; modelId: string }; source: TasksetPackage }): ModelTasksetDraftPreparation {
  const request = ModelTasksetDraftRequestSchema.parse(input.request);
  const owner = ModelTasksetAuthoringOwnerSchema.parse(input.owner);
  const source = requireOrdinaryPackage(input.source);
  if (source.contentHash !== request.sourcePackageHash) throw new Error("Taskset draft source package changed.");
  const previous = assertModelTasksetAuthoring(source.taskset);
  const owned = previous && contentHash(previous.owner) === contentHash(owner);
  const root = owned ? previous.root : learningRef(source.taskset);
  const lineage = { schemaVersion: "openpond.modelTasksetAuthoring.v1" as const, owner, root, parent: learningRef(source.taskset) };
  return ModelTasksetDraftPreparationSchema.parse({
    schemaVersion: "openpond.modelTasksetDraftPreparation.v1",
    draftId: `model-taskset-draft-${contentHash({ owner, operationId: request.operationId })}`,
    requestHash: contentHash(request), sourcePackageHash: source.contentHash, sourceTasksetRef: learningRef(source.taskset),
    tasksetId: modelAuthoredTasksetId(lineage), tasksetRevision: owned ? source.taskset.revision + 1 : 1, lineage,
  });
}

/** The edited package already carries exact file bytes and execution releases.
 * Seal the owned revision without copying qualification for different bytes. */
export function publishModelTasksetDraftPackage(input: { preparation: ModelTasksetDraftPreparation; edited: TasksetPackage }): TasksetPackage {
  const prepared = ModelTasksetDraftPreparationSchema.parse(input.preparation);
  if (!sameLearningRef(prepared.sourceTasksetRef, prepared.lineage.parent)) throw new Error("Taskset draft preparation differs from its source lineage.");
  const edited = requireOrdinaryPackage(input.edited);
  const { contentHash: _verifierHash, ...verifierContent } = edited.verifierSet;
  const verifierSet = createVerifierSetRelease({ ...verifierContent, id: `${prepared.tasksetId}-verifiers`, revision: prepared.tasksetRevision,
    calibrationReceiptRefs: [], metadata: { sourceVerifierSet: learningRef(edited.verifierSet) } });
  const { contentHash: _hash, ...content } = edited.taskset;
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ ...content, id: prepared.tasksetId, revision: prepared.tasksetRevision,
    verifierSetRelease: { id: verifierSet.id, contentHash: verifierSet.contentHash },
    metadata: {
      modelTasksetAuthoring: prepared.lineage,
      ...(edited.taskset.metadata.environmentResources === undefined ? {} : { environmentResources: edited.taskset.metadata.environmentResources }),
      ...(edited.taskset.metadata.ordinaryAuthoring === undefined ? {} : { ordinaryAuthoring: edited.taskset.metadata.ordinaryAuthoring }),
    },
  }));
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, environment: edited.environment, verifierSet, files: edited.files });
}

function requireOrdinaryPackage(value: unknown) {
  const result = validateTasksetPackage(value);
  if (result.modelResources || result.learningResources) throw new Error("This Taskset requires its bound or reviewed authoring workflow.");
  return result;
}
