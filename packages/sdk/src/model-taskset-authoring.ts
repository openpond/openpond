import { contentHash } from "@openpond/harness";
import { createVerifierSetRelease } from "@openpond/evals";
import { learningRef, sameLearningRef, sealLearningContent } from "@openpond/evals/learning";
import { TasksetReleaseSchema } from "@openpond/evals/tasksets";
import { ModelTasksetAuthoringOwnerSchema, ModelTasksetDraftPreparationSchema, ModelTasksetDraftRequestSchema, type ModelTasksetDraftPreparation, type ModelTasksetDraftRequest } from "./model-taskset-authoring-contracts.js";
import { assertModelTasksetAuthoring, modelAuthoredTasksetId } from "./model-taskset-authoring-lineage.js";
import { createTasksetPackage, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { createTasksetPackageExecutionFile, resolveTasksetPackageExecution } from "./taskset-package-execution.js";
import { modelStarterExecutionAssetId } from "./model-starter-execution.js";
import { deriveModelTaskset } from "./model-taskset-derivation.js";
import { publishBoundModelTasksetDraftPackage } from "./model-bound-taskset-authoring.js";

export * from "./model-taskset-authoring-contracts.js";

/** Resolve under an authorized Model CAS. The host retains requestHash and the
 * preparation so retrying cannot choose newer source bytes or another draft. */
export function prepareModelTasksetDraft(input: { request: ModelTasksetDraftRequest; owner: { scopeId: string; modelId: string }; source: TasksetPackage }): ModelTasksetDraftPreparation {
  const request = ModelTasksetDraftRequestSchema.parse(input.request);
  const owner = ModelTasksetAuthoringOwnerSchema.parse(input.owner);
  const source = validateTasksetPackage(input.source);
  if (source.learningResources) throw new Error("Reviewed Tasksets require their reviewed authoring workflow.");
  if (source.contentHash !== request.sourcePackageHash) throw new Error("Taskset draft source package changed.");
  if (source.modelResources) {
    const derived = deriveModelTaskset({ owner, source: { ...source.modelResources, taskset: source.taskset, executionResources: { environment: source.environment, verifierSet: source.verifierSet } },
      rewardBinding: source.modelResources.rewardBinding, rewards: source.modelResources.rewards, assets: source.modelResources.assets });
    const lineage = derived.taskset.metadata.modelTasksetDerivation as { owner: typeof owner; root: ReturnType<typeof learningRef>; parent: ReturnType<typeof learningRef> };
    return ModelTasksetDraftPreparationSchema.parse({ schemaVersion: "openpond.modelTasksetDraftPreparation.v1",
      draftId: `model-taskset-draft-${contentHash({ owner, operationId: request.operationId })}`, requestHash: contentHash(request),
      sourcePackageHash: source.contentHash, sourceTasksetRef: learningRef(source.taskset), tasksetId: derived.taskset.id,
      tasksetRevision: derived.taskset.revision, lineage: { ...lineage, schemaVersion: "openpond.modelTasksetAuthoring.v1" }, authoringGraph: "bound",
    });
  }
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
export function publishModelTasksetDraftPackage(input: { preparation: ModelTasksetDraftPreparation; edited: TasksetPackage; source?: TasksetPackage }): TasksetPackage {
  const prepared = ModelTasksetDraftPreparationSchema.parse(input.preparation);
  if (!sameLearningRef(prepared.sourceTasksetRef, prepared.lineage.parent)) throw new Error("Taskset draft preparation differs from its source lineage.");
  if (prepared.authoringGraph === "bound") {
    if (!input.source) throw new Error("Bound Taskset authoring requires its retained source package.");
    return publishBoundModelTasksetDraftPackage({ preparation: prepared, source: input.source, edited: input.edited });
  }
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
  const resolved = resolveTasksetPackageExecution(edited);
  const files = resolved ? [
    ...edited.files.filter(file => file.asset.id !== modelStarterExecutionAssetId(edited.taskset)),
    createTasksetPackageExecutionFile({ ...resolved.execution, verifierSet }),
  ] : edited.files;
  return createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset, environment: edited.environment, verifierSet, files });
}

function requireOrdinaryPackage(value: unknown) {
  const result = validateTasksetPackage(value);
  if (result.modelResources || result.learningResources) throw new Error("This Taskset requires its bound or reviewed authoring workflow.");
  return result;
}
