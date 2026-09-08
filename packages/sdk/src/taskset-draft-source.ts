import { z } from "zod";
import { contentHash, sha256 } from "@openpond/harness";
import { learningRef, sameLearningRef } from "@openpond/evals/learning";
import { ModelTasksetDraftPreparationSchema, TasksetDraftFilePathSchema, type ModelTasksetDraftPreparation } from "./model-taskset-authoring-contracts.js";
import { TasksetDraftSchema, type TasksetDraft } from "./taskset-draft-document.js";
import { AuthoredTasksetFileInventorySchema } from "./taskset-authored-files.js";
import { validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { isManagedTasksetDraftFilePath } from "./taskset-draft-files.js";
import { configuredTasksetDraftFiles } from "./taskset-draft-manifests.js";
import { createTasksetDraftWorkspace, decodeTasksetDraftWorkspaceFile, type TasksetDraftWorkspaceFile } from "./taskset-draft-workspace.js";

export const TasksetDraftSourceInitializationSchema = z.object({
  draft: TasksetDraftSchema,
  filePaths: z.array(z.object({ assetId: z.string().min(1), paths: z.array(TasksetDraftFilePathSchema).min(1).max(10_000) }).strict()).max(10_000),
}).strict();
export type TasksetDraftSourceInitialization = z.infer<typeof TasksetDraftSourceInitializationSchema>;

/** Hosts authorize the source projection and retain this result before writes.
 * Ownership comes from preparation, never from editable projection metadata. */
export function prepareTasksetDraftSource(input: { sourceDraft: TasksetDraft; source: TasksetPackage; preparation: ModelTasksetDraftPreparation; expectedModelRevision: number }): TasksetDraftSourceInitialization {
  const source = validateTasksetPackage(input.source);
  const original = TasksetDraftSchema.parse(input.sourceDraft);
  const preparation = ModelTasksetDraftPreparationSchema.parse(input.preparation);
  if (source.contentHash !== preparation.sourcePackageHash || !sameLearningRef(learningRef(source.taskset), preparation.sourceTasksetRef)) throw new Error("Taskset draft preparation differs from its source package.");
  if (source.modelResources || source.learningResources) throw new Error("This Taskset requires its bound or reviewed authoring workflow.");
  const inventory = AuthoredTasksetFileInventorySchema.parse(original.metadata.portableFileInventory ?? []);
  const sourcePath = (relative: string) => isManagedTasksetDraftFilePath(relative)
    ? `source-artifacts/${source.contentHash}/${contentHash(relative)}/${relative.split("/").at(-1)!}` : relative;
  const references = [...original.tasks.flatMap(task => (task.assets ?? []).map(asset => asset.artifactRef)),
    ...(original.environment.resources ?? []).map(resource => resource.path),
    ...source.taskset.tasks.flatMap(task => (task.requiredOutputs ?? []).flatMap(output => output.schemaRef ? [output.schemaRef.path] : [])),
    ...(original.metrics.customAggregator ? [original.metrics.customAggregator.module] : []),
    ...original.graders.flatMap(grader => grader.kind === "custom_verifier" ? [grader.module] : [])];
  if (references.some(isManagedTasksetDraftFilePath)) throw new Error("A referenced source asset occupies a reserved Taskset authoring path.");
  const filePaths = source.files.map(file => {
    const paths = new Set([file.asset.path]);
    for (const entry of inventory) if (entry.asset.id === file.asset.id) paths.add(entry.sourcePath);
    for (const task of original.tasks) for (const asset of task.assets ?? []) if (asset.id === file.asset.id) paths.add(asset.artifactRef);
    for (const grader of source.taskset.graders) if (grader.kind === "custom_verifier" && grader.verifierRef.id === file.asset.id) {
      const projected = original.graders.find(candidate => candidate.id === grader.id);
      if (projected?.kind === "custom_verifier") paths.add(projected.module);
    }
    return { assetId: file.asset.id, paths: [...paths].map(sourcePath) };
  });
  const draft = TasksetDraftSchema.parse({ ...original, id: preparation.draftId, revision: 1, status: "draft",
    environment: { ...original.environment, metadata: { ...original.environment.metadata, portableExecutionResources: { environment: source.environment } } },
    modelScope: { modelId: preparation.lineage.owner.modelId, expectedModelRevision: input.expectedModelRevision, source: preparation },
    publishedTasksetRef: preparation.tasksetRevision > 1 ? preparation.sourceTasksetRef : null,
    metadata: { ...original.metadata, modelTasksetAuthoring: preparation.lineage,
      portableFileInventory: inventory.map(entry => ({ ...entry, sourcePath: sourcePath(entry.sourcePath), asset: { ...entry.asset,
        id: isManagedTasksetDraftFilePath(entry.sourcePath) ? `source-artifact-${contentHash({ packageHash: source.contentHash, assetId: entry.asset.id })}` : entry.asset.id,
        path: sourcePath(entry.asset.path) } })) },
  });
  return TasksetDraftSourceInitializationSchema.parse({ draft, filePaths });
}

/** Materialize the retained source into an immutable draft snapshot. Callers
 * must never replace a newer saved snapshot with this initial population. */
export function materializeTasksetDraftWorkspace(input: { initialized: TasksetDraftSourceInitialization; source: TasksetPackage }) {
  const initialized = TasksetDraftSourceInitializationSchema.parse(input.initialized);
  const source = validateTasksetPackage(input.source);
  if (initialized.draft.modelScope?.source?.sourcePackageHash !== source.contentHash) throw new Error("Taskset draft lost its source preparation.");
  const files = new Map<string, TasksetDraftWorkspaceFile>();
  for (const mapping of initialized.filePaths) {
    const file = source.files.find(candidate => candidate.asset.id === mapping.assetId);
    if (!file) throw new Error("Taskset draft source asset is missing.");
    for (const path of mapping.paths) {
      const previous = files.get(path);
      if (previous && previous.contentHash !== file.asset.contentHash) throw new Error("Taskset draft source paths conflict.");
      files.set(path, { path, contentHash: file.asset.contentHash, sizeBytes: file.asset.sizeBytes, base64: file.base64 });
    }
  }
  for (const configured of configuredTasksetDraftFiles(initialized.draft)) if (!files.has(configured.relativePath)) {
    const bytes = new TextEncoder().encode(configured.source);
    files.set(configured.relativePath, { path: configured.relativePath, contentHash: sha256(bytes), sizeBytes: bytes.byteLength, base64: Buffer.from(bytes).toString("base64") });
  }
  let draft = initialized.draft;
  if (draft.metrics.customAggregator) {
    const file = files.get(draft.metrics.customAggregator.module);
    if (!file) throw new Error("Declared Taskset metric module is missing.");
    decodeTasksetDraftWorkspaceFile(file);
    draft = TasksetDraftSchema.parse({ ...draft, metrics: { ...draft.metrics, customAggregator: { ...draft.metrics.customAggregator, contentHash: file.contentHash } } });
  }
  return createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft, files: [...files.values()] });
}
