import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TasksetSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { learningRef, sameLearningRef } from "@openpond/evals/learning";
import { hashTasksetDraftPackage, materializePortableTasksetRelease, tasksetDraftFromTaskset, writeTasksetDraftPackage } from "@openpond/taskset-sdk";
import { ModelProjectSchema } from "openpond-sdk/model-projects";
import { ModelTasksetAuthoringSchema, ModelTasksetDraftRequestSchema, decodeTasksetPackageFile, prepareModelTasksetDraft, type ModelTasksetDraftRequest, type TasksetPackage } from "openpond-sdk/taskset-packages";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";
import { desktopTasksetRuntimeAdapterId } from "../training/portable-evals-adapter.js";
import { cacheTasksetPackage, readCachedTasksetPackage } from "../training/taskset-package-files.js";
import { TasksetDraftSourceInitializationSchema, prepareTasksetDraftSource } from "openpond-sdk/taskset-packages";

export const ModelDraftInitializationSchema = TasksetDraftSourceInitializationSchema.extend({
  workspaceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type ModelDraftInitialization = z.infer<typeof ModelDraftInitializationSchema>;

/** Persist the source snapshot before filesystem work. Retries resolve the
 * original operation before checking the Model's possibly newer revision. */
export async function prepareDraftInitialization(input: { db: OpenPondSqliteConnection; home: string; profileId: string; request: ModelTasksetDraftRequest; source?: TasksetPackage }) {
  const { db, profileId } = input;
  const request = ModelTasksetDraftRequestSchema.parse(input.request);
  const requireModel = () => {
    const row = db.get<{ payload: string }>("SELECT payload FROM model_projects WHERE id = ? AND profile_id = ?", [request.modelId, profileId]);
    if (!row) throw new Error("Taskset draft Model was not found in this Profile.");
    return ModelProjectSchema.parse(JSON.parse(row.payload));
  };
  const model = requireModel();
  const requestHash = contentHash(request);
  const prior = db.get<{ request_hash: string; state: string; payload: string }>("SELECT request_hash, state, payload FROM model_taskset_draft_operations WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("Taskset draft operation was reused with different input.");
    if (prior.state === "deleted") throw new Error("This Taskset draft was deleted.");
    return ModelDraftInitializationSchema.parse(JSON.parse(prior.payload));
  }
  if (!input.source) return null;
  if (model.revision !== request.expectedModelRevision) throw new Error("Model changed before draft initialization. Refresh before editing.");
  const ref = model.trainingSetup.tasksetRef;
  const row = ref ? db.get<{ payload: string }>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ? AND profile_id = ?", [ref.id, ref.revision, profileId]) : null;
  const source = row ? TasksetSchema.parse(JSON.parse(row.payload)) : null;
  if (!source || !ref || source.contentHash !== ref.contentHash) throw new Error("The selected source Taskset is unavailable.");
  const sourcePackage = input.source;
  const linked = model.hosted?.apiOrigin ? model.hosted.tasksets.find(link => link.localTasksetId === source.id && link.localTasksetHash === source.contentHash
    && link.packageHash === sourcePackage.contentHash && link.releaseId === sourcePackage.taskset.id && link.releaseRevision === sourcePackage.taskset.revision && link.releaseHash === sourcePackage.taskset.contentHash) : null;
  const cachedHash = typeof source.metadata.importedPackageHash === "string" ? source.metadata.importedPackageHash : linked?.packageHash;
  if (cachedHash ? cachedHash !== sourcePackage.contentHash : !sameLearningRef(learningRef(materializePortableTasksetRelease({ taskset: source, adapterId: desktopTasksetRuntimeAdapterId(source) }).tasksetRelease), learningRef(sourcePackage.taskset))) {
    throw new Error("Taskset draft package differs from its selected source.");
  }
  const previous = ModelTasksetAuthoringSchema.safeParse(sourcePackage.taskset.metadata.modelTasksetAuthoring);
  const owner = linked && previous.success && previous.data.owner.modelId === model.id ? previous.data.owner : { scopeId: profileId, modelId: model.id };
  const preparation = prepareModelTasksetDraft({ request, owner, source: sourcePackage });
  const prepared = prepareTasksetDraftSource({ sourceDraft: tasksetDraftFromTaskset(source), source: sourcePackage, preparation, expectedModelRevision: request.expectedModelRevision });
  // Capture immutable bytes before retaining the initialization operation.
  await cacheTasksetPackage(input.home, sourcePackage);
  const initialized = ModelDraftInitializationSchema.parse({ ...prepared, workspaceHash: null });
  const draft = initialized.draft;
  db.exec("BEGIN IMMEDIATE");
  try {
    const concurrent = db.get<{ request_hash: string }>("SELECT request_hash FROM model_taskset_draft_operations WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
    if (concurrent && concurrent.request_hash !== requestHash) throw new Error("Taskset draft operation was reused with different input.");
    if (!concurrent && requireModel().revision !== request.expectedModelRevision) throw new Error("Model changed during draft initialization. Refresh before editing.");
    db.run("INSERT INTO model_taskset_draft_operations (profile_id, operation_id, request_hash, draft_id, state, payload) VALUES (?, ?, ?, ?, 'prepared', ?) ON CONFLICT(profile_id, operation_id) DO NOTHING",
      [profileId, request.operationId, requestHash, draft.id, JSON.stringify(initialized)]);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  // A concurrent identical initialization may have committed its timestamp and
  // source snapshot first. Always use that retained preparation.
  const retained = db.get<{ request_hash: string; payload: string }>("SELECT request_hash, payload FROM model_taskset_draft_operations WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
  if (!retained || retained.request_hash !== requestHash) throw new Error("Taskset draft operation was reused with different input.");
  return ModelDraftInitializationSchema.parse(JSON.parse(retained.payload));
}

/** The final directory is never replaced. An interrupted rename can be resumed
 * only when the prepared hash matches; a completed draft may contain newer edits. */
export async function materializeDraftInitialization(input: { home: string; initialized: ModelDraftInitialization; workspacePath: string; completed: () => boolean; retainHash: (value: ModelDraftInitialization) => void }) {
  const { initialized, workspacePath } = input;
  if (input.completed()) return;
  if (initialized.workspaceHash) {
    try {
      await lstat(workspacePath);
      if (input.completed()) return;
      await assertRegularTree(workspacePath);
      if (await hashTasksetDraftPackage(workspacePath) !== initialized.workspaceHash) throw new Error("Prepared Taskset draft files changed before initialization completed.");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const temporary = `${workspacePath}.initializing-${randomUUID()}`;
  await mkdir(path.dirname(workspacePath), { recursive: true });
  try {
    const source = initialized.draft.modelScope?.source;
    if (!source) throw new Error("Taskset draft lost its source preparation.");
    const value = await readCachedTasksetPackage(input.home, source.sourcePackageHash);
    const written = new Map<string, string>();
    for (const mapping of initialized.filePaths) {
      const file = value.files.find(candidate => candidate.asset.id === mapping.assetId);
      if (!file) throw new Error("Taskset draft source asset is missing.");
      for (const relative of mapping.paths) {
        if (relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".env"))) throw new Error("Taskset draft source path is invalid.");
        const existing = written.get(relative);
        if (existing && existing !== file.asset.contentHash) throw new Error("Taskset draft source paths conflict.");
        if (existing) continue;
        const target = path.join(temporary, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, decodeTasksetPackageFile(file), { flag: "wx" });
        written.set(relative, file.asset.contentHash);
      }
    }
    await writeTasksetDraftPackage(initialized.draft, temporary);
    // Authoring manifests and generated starter files must never overwrite a
    // packaged source asset, even when a package uses one of their paths.
    for (const [relative, expectedHash] of written) {
      const actualHash = createHash("sha256").update(await readFile(path.join(temporary, relative))).digest("hex");
      if (actualHash !== expectedHash) throw new Error(`Taskset draft source asset conflicts with authoring file ${relative}.`);
    }
    const workspaceHash = await hashTasksetDraftPackage(temporary);
    input.retainHash({ ...initialized, workspaceHash });
    if (input.completed()) return;
    try { await rename(temporary, workspacePath); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (input.completed()) return;
      await assertRegularTree(workspacePath);
      if (await hashTasksetDraftPackage(workspacePath) !== workspaceHash) throw new Error("Prepared Taskset draft files changed before initialization completed.");
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function assertRegularTree(directory: string): Promise<void> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Taskset draft source must be a regular directory.");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".env") || entry.isSymbolicLink()) throw new Error("Taskset draft source contains a prohibited file.");
    if (entry.isDirectory()) await assertRegularTree(path.join(directory, entry.name));
    else if (!entry.isFile()) throw new Error("Taskset draft source must contain regular files.");
  }
}
