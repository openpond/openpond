import { contentHash } from "@openpond/harness";
import { ModelTasksetDraftPreparationSchema, type ModelTasksetDraftPreparation } from "./model-taskset-authoring-contracts.js";
import { publishModelTasksetDraftPackage } from "./model-taskset-authoring.js";
import { publishTasksetDraft } from "./taskset-draft-publication.js";
import { validateTasksetDraftWorkspace, decodeTasksetDraftWorkspaceFile, type TasksetDraftWorkspace } from "./taskset-draft-workspace.js";
import { renderTasksetDraftManifests } from "./taskset-draft-manifests.js";
import { AuthoredTasksetFileInventorySchema, isGeneratedTasksetPublicationFilePath, prepareAuthoredTasksetSource } from "./taskset-authored-files.js";
import { materializePortableTasksetRelease } from "./taskset-authored-portable-release.js";
import { createTasksetPackage } from "./taskset-package-contracts.js";

/** Use the same validation, file pinning and release projection as Desktop.
 * Compilation neither executes models/graders nor selects the resulting release.
 * The host supplies its retained preparation and later commits Model/draft CAS. */
export function compileModelTasksetDraftWorkspace(input: {
  workspace: TasksetDraftWorkspace;
  preparation: ModelTasksetDraftPreparation | null;
  adapterId: string;
  now: string;
}) {
  const workspace = validateTasksetDraftWorkspace(input.workspace);
  const preparation = input.preparation === null ? null : ModelTasksetDraftPreparationSchema.parse(input.preparation);
  if (!workspace.draft.modelScope) throw new Error("Taskset draft requires a Model owner.");
  if (preparation ? workspace.draft.id !== preparation.draftId || workspace.draft.modelScope.modelId !== preparation.lineage.owner.modelId
    || workspace.draft.profileId !== preparation.lineage.owner.scopeId
    || contentHash(workspace.draft.modelScope.source ?? null) !== contentHash(preparation)
    : workspace.draft.modelScope.source !== undefined) throw new Error("Taskset draft differs from its retained source preparation.");
  // Validation and publication may happen in different requests. Package
  // identity depends on saved bytes, including their timestamp, not wall time.
  const taskset = publishTasksetDraft({ draft: workspace.draft, now: workspace.draft.updatedAt, sourcePackageHash: workspace.contentHash });
  const files = new Map(workspace.files.map(file => [file.path, decodeTasksetDraftWorkspaceFile(file)]));
  for (const [path, source] of renderTasksetDraftManifests(workspace.draft)) if (!isGeneratedTasksetPublicationFilePath(path)) files.set(path, new TextEncoder().encode(source));
  const authored = prepareAuthoredTasksetSource(taskset, files, input.adapterId);
  for (const file of authored.generatedFiles) files.set(file.path, new TextEncoder().encode(file.content));
  const releases = materializePortableTasksetRelease({ taskset: authored.taskset, adapterId: input.adapterId });
  const inventory = AuthoredTasksetFileInventorySchema.parse(authored.taskset.metadata.portableFileInventory);
  const edited = createTasksetPackage({ schemaVersion: "openpond.tasksetPackage.v1", taskset: releases.tasksetRelease,
    environment: releases.environmentRelease, verifierSet: releases.verifierSetRelease,
    files: inventory.map(entry => {
      const bytes = files.get(entry.sourcePath);
      if (!bytes) throw new Error(`Captured Taskset file is missing: ${entry.sourcePath}.`);
      return { asset: entry.asset, base64: Buffer.from(bytes).toString("base64") };
    }),
  });
  return preparation ? publishModelTasksetDraftPackage({ preparation, edited }) : edited;
}
