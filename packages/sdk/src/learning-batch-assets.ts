import { contentHash, sha256 } from "@openpond/harness";
import { verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import type { TaskRecord } from "@openpond/evals/tasksets";

/** Capture exact admitted input bytes under task-specific materialization paths. */
export function materializeLearningBatchAssets(input: {
  tasks: TaskRecord[]; sourceId: string; assets?: LearningTextAsset[];
  assetBytes?: ReadonlyMap<string, Uint8Array>;
}) {
  const tasksetAssetBytes = new Map<string, Uint8Array>();
  const tasks = input.tasks.map(({ artifactRefs, ...task }) => ({
    ...task,
    assets: artifactRefs.map(asset => {
      if (asset.visibility !== "policy") throw new Error("Learning task inputs must be policy-visible assets.");
      const stored = input.assets?.find(value => value.id === asset.id);
      const bytes = input.assetBytes?.get(asset.id)
        ?? (stored ? new TextEncoder().encode(verifyLearningTextAsset(stored, asset)) : undefined);
      if (!bytes || bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.contentHash) throw new Error(`Learning task input bytes are missing or changed: ${asset.id}.`);
      const artifactRef = `learning/assets/${contentHash({ task: task.id, asset: asset.id }).slice(0, 40)}/${asset.path}`;
      tasksetAssetBytes.set(artifactRef, new Uint8Array(bytes));
      return { id: asset.id, sourceRefId: input.sourceId, artifactRef,
        fileName: asset.path.split("/").at(-1)!, mediaType: asset.mediaType,
        sha256: asset.contentHash, sizeBytes: asset.sizeBytes, split: task.split, metadata: { portableAsset: asset } };
    }),
    ...(task.requiredOutputs ? { requiredOutputs: task.requiredOutputs.map(output => ({ ...output,
      schemaRef: output.schemaRef?.id ?? null, maxBytes: output.maxBytes ?? undefined })) } : {}),
  }));
  return { tasks, tasksetAssetBytes };
}
