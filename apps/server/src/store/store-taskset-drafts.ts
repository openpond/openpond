import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  TasksetDraftSchema,
  TasksetSchema,
  type Taskset,
  type TasksetDraft,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import {
  hashTasksetDraftPackage,
  readTasksetDraftPackage,
  computeTasksetHash,
  writeTasksetDraftPackage,
} from "@openpond/taskset-sdk";
import { z } from "zod";
import { ModelProjectSchema } from "openpond-sdk/model-projects";

import type { PayloadRow } from "../types.js";
import { SqlitePreferenceComparisonStore } from "./store-preference-comparison.js";
import { materializeImmutableTasksetPackage } from "../training/model-starter-package-files.js";
import { verifyPublishedTasksetAssets } from "../training/taskset-package-assets.js";
import { prepareAuthoredTasksetFiles } from "../training/authored-taskset-files.js";
import { saveTasksetRevision } from "./store-taskset-revisions.js";
import { selectTasksetDraftModel } from "./store-taskset-draft-model.js";
import { ModelDraftInitializationSchema, materializeDraftInitialization, prepareDraftInitialization } from "./store-model-taskset-draft-initialization.js";
import type { ModelTasksetDraftRequest, TasksetPackage } from "openpond-sdk/taskset-packages";
import { materializeModelTasksetDraftPublication } from "../training/model-taskset-draft-publication.js";

const TasksetDraftPointerSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftPointer.v1"),
  id: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
  modelScope: TasksetDraftSchema.shape.modelScope,
  status: z.enum(["draft", "validating", "needs_review", "published"]),
  revision: z.number().int().positive(),
  workspacePath: z.string().trim().min(1),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  publishedTasksetRef: z.object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
    contentHash: z.string().trim().min(8),
  }).nullable(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

export type TasksetDraftWorkspace = {
  draftId: string;
  workspacePath: string;
  packageHash: string;
};

type TasksetDraftPointer = z.infer<typeof TasksetDraftPointerSchema>;

export class SqliteTasksetDraftStore extends SqlitePreferenceComparisonStore {
  async initializeModelTasksetDraft(profileId: string, request: ModelTasksetDraftRequest, source?: TasksetPackage): Promise<TasksetDraft | null> {
    await this.ready;
    const operation = this.writeQueue.then(async () => {
      const db = this.database;
      const initialized = await prepareDraftInitialization({ db, home: this.home, profileId, request, source });
      if (!initialized) return null;
      const completed = () => {
        const state = db.get<{ state: string }>("SELECT state FROM model_taskset_draft_operations WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
        if (state?.state === "deleted") throw new Error("This Taskset draft was deleted.");
        const row = db.get<PayloadRow>("SELECT payload FROM taskset_drafts WHERE id = ?", [initialized.draft.id]);
        if (!row) {
          if (state?.state === "ready") throw new Error("The initialized Taskset draft is unavailable.");
          return false;
        }
        const pointer = TasksetDraftPointerSchema.parse(JSON.parse(row.payload));
        if (pointer.profileId !== profileId || pointer.modelScope?.source?.requestHash !== initialized.draft.modelScope?.source?.requestHash) throw new Error("Taskset draft identity conflicts with its initialization.");
        return true;
      };
      const workspacePath = this.workspacePath(initialized.draft.id);
      await materializeDraftInitialization({ home: this.home, initialized, workspacePath, completed, retainHash: value => {
        const retained = db.get<PayloadRow>("SELECT payload FROM model_taskset_draft_operations WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
        const prior = ModelDraftInitializationSchema.parse(JSON.parse(retained!.payload));
        if (prior.workspaceHash && prior.workspaceHash !== value.workspaceHash) throw new Error("Taskset draft initialization produced different files on retry.");
        db.run("UPDATE model_taskset_draft_operations SET payload = ? WHERE profile_id = ? AND operation_id = ? AND state = 'prepared'", [JSON.stringify(value), profileId, request.operationId]);
      } });
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!completed()) {
          const retained = db.get<PayloadRow>("SELECT payload FROM model_taskset_draft_operations WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
          const preparation = ModelDraftInitializationSchema.parse(JSON.parse(retained!.payload));
          const draft = preparation.draft;
          const pointer = TasksetDraftPointerSchema.parse({ schemaVersion: "openpond.tasksetDraftPointer.v1", id: draft.id, profileId,
            modelScope: draft.modelScope, status: draft.status, revision: draft.revision, workspacePath, packageHash: preparation.workspaceHash,
            publishedTasksetRef: draft.publishedTasksetRef, createdAt: draft.createdAt, updatedAt: draft.updatedAt });
          db.run("INSERT INTO taskset_drafts (id, profile_id, status, revision, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [draft.id, profileId, draft.status, draft.revision, JSON.stringify(pointer), draft.createdAt, draft.updatedAt]);
          db.run("UPDATE model_taskset_draft_operations SET state = 'ready' WHERE profile_id = ? AND operation_id = ?", [profileId, request.operationId]);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const row = db.get<PayloadRow>("SELECT payload FROM taskset_drafts WHERE id = ?", [initialized.draft.id]);
      return this.draftFromStoredPayload(JSON.parse(row!.payload));
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async saveTasksetDraft(draftInput: TasksetDraft, expectedRevision?: number, options: { refreshModelRevision?: boolean } = {}): Promise<TasksetDraft> {
    const draft = TasksetDraftSchema.parse(draftInput);
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const existing = this.database.get<PayloadRow>("SELECT payload FROM taskset_drafts WHERE id = ?", [draft.id]);
      const current = existing ? TasksetDraftPointerSchema.safeParse(JSON.parse(existing.payload)) : null;
      if (current?.success) {
        if (current.data.profileId !== draft.profileId) throw new Error("Taskset draft profile cannot change.");
        if (contentHash(current.data.modelScope ? { ...current.data.modelScope, expectedModelRevision: 0 } : null) !== contentHash(draft.modelScope ? { ...draft.modelScope, expectedModelRevision: 0 } : null)
          || (!options.refreshModelRevision && contentHash(current.data.modelScope) !== contentHash(draft.modelScope))) throw new Error("Taskset draft Model ownership cannot change.");
        if (current.data.status === "published") throw new Error("Published Taskset drafts are immutable. Initialize a new draft to revise the Taskset.");
        if (draft.revision < current.data.revision || (expectedRevision !== undefined && current.data.revision !== expectedRevision)) throw new Error("Taskset draft changed before saving. Refresh before saving.");
      } else if (expectedRevision !== undefined) throw new Error("Taskset draft is unavailable for saving.");
      if ((!current?.success || options.refreshModelRevision) && draft.modelScope) {
        const model = this.database.get<PayloadRow>("SELECT payload FROM model_projects WHERE id = ? AND profile_id = ?", [draft.modelScope.modelId, draft.profileId]);
        if (!model) throw new Error("Taskset draft Model was not found in this Profile.");
        if (ModelProjectSchema.parse(JSON.parse(model.payload)).revision !== draft.modelScope.expectedModelRevision) throw new Error("Taskset draft Model changed. Refresh before editing.");
      }
      const workspacePath = this.workspacePath(draft.id);
      const written = await writeTasksetDraftPackage(draft, workspacePath);
      const persistedDraft = written.draft;
      const pointer = TasksetDraftPointerSchema.parse({
        schemaVersion: "openpond.tasksetDraftPointer.v1",
        id: persistedDraft.id,
        profileId: persistedDraft.profileId,
        modelScope: persistedDraft.modelScope,
        status: persistedDraft.status,
        revision: persistedDraft.revision,
        workspacePath,
        packageHash: await hashTasksetDraftPackage(workspacePath),
        publishedTasksetRef: persistedDraft.publishedTasksetRef,
        createdAt: persistedDraft.createdAt,
        updatedAt: persistedDraft.updatedAt,
    });
    await this.savePointer(pointer, true);
    return persistedDraft;
    });
    this.writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async importTasksetDraftPackage(input: {
    packagePath: string;
    profileId: string;
  }): Promise<TasksetDraft> {
    const sourcePath = path.resolve(input.packagePath);
    const sourceStats = await stat(sourcePath);
    const sourceDirectory = sourceStats.isDirectory()
      ? sourcePath
      : path.dirname(sourcePath);
    await assertRegularPackageTree(sourceDirectory);
    const sourceHash = await hashTasksetDraftPackage(sourceDirectory);
    const sourceDraft = await readTasksetDraftPackage(sourceDirectory);
    const existing = await this.getTasksetDraft(sourceDraft.id);
    if (existing) {
      const imported = existing.metadata.importedTasksetPackage;
      if (
        imported
        && typeof imported === "object"
        && !Array.isArray(imported)
        && (imported as Record<string, unknown>).packageHash === sourceHash
        && existing.profileId === input.profileId
      ) {
        return existing;
      }
      throw new Error(
        `Taskset draft ${sourceDraft.id} already exists. Import a package with a distinct Taskset id.`,
      );
    }
    const importedDraft = TasksetDraftSchema.parse({
      ...sourceDraft,
      profileId: input.profileId,
      modelScope: null,
      status: "draft",
      revision: 1,
      publishedTasksetRef: null,
      metadata: {
        ...sourceDraft.metadata,
        importedTasksetPackage: {
          packageHash: sourceHash,
          importedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    });
    const workspacePath = this.workspacePath(importedDraft.id);
    const temporaryPath = `${workspacePath}.import-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(workspacePath), { recursive: true });
    try {
      await cp(sourceDirectory, temporaryPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      await writeTasksetDraftPackage(importedDraft, temporaryPath);
      await rename(temporaryPath, workspacePath);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
    const pointer = TasksetDraftPointerSchema.parse({
      schemaVersion: "openpond.tasksetDraftPointer.v1",
      id: importedDraft.id,
      profileId: importedDraft.profileId,
      status: importedDraft.status,
      revision: importedDraft.revision,
      workspacePath,
      packageHash: await hashTasksetDraftPackage(workspacePath),
      publishedTasksetRef: importedDraft.publishedTasksetRef,
      createdAt: importedDraft.createdAt,
      updatedAt: importedDraft.updatedAt,
    });
    await this.savePointer(pointer);
    return importedDraft;
  }

  async materializePublishedTasksetPackage(input: {
    draftId: string;
    taskset: Taskset;
  }): Promise<{ directory: string; taskset: Taskset }> {
    const workspace = await this.getTasksetDraftWorkspace(input.draftId);
    if (!workspace) {
      throw new Error(`Taskset draft ${input.draftId} workspace was not found.`);
    }
    if (input.taskset.metadata.sourcePackageHash !== undefined && input.taskset.metadata.sourcePackageHash !== workspace.packageHash) {
      throw new Error("Taskset draft files changed before publication. Refresh before publishing.");
    }
    const directoryId = `draft-${contentHash({ taskset: input.taskset, packageHash: workspace.packageHash })}`;
    const authored = await prepareAuthoredTasksetFiles(input.taskset, workspace.workspacePath);
    const prepared = TasksetSchema.parse({
      ...authored.taskset,
      metadata: { ...authored.taskset.metadata, sourcePackageHash: workspace.packageHash },
      environment: { ...authored.taskset.environment, metadata: { ...authored.taskset.environment.metadata, runtimeSourceTasksetId: directoryId } },
    });
    const taskset = TasksetSchema.parse({ ...prepared, contentHash: computeTasksetHash(prepared) });
    const directory = await materializeImmutableTasksetPackage(this.home, { taskset, generatedFiles: authored.generatedFiles }, directoryId, {
      source: { directory: workspace.workspacePath, packageHash: workspace.packageHash },
      verify: root => verifyPublishedTasksetAssets(root, taskset),
    });
    const draft = await this.getTasksetDraft(input.draftId);
    if (draft?.modelScope?.source) return materializeModelTasksetDraftPublication({ home: this.home, directory, taskset, preparation: draft.modelScope.source });
    return { directory, taskset };
  }

  async finalizeTasksetDraftPublication(input: {
    draft: TasksetDraft;
    packageHash: string;
    taskset: Taskset;
  }): Promise<{ draft: TasksetDraft; taskset: Taskset }> {
    await this.ready;
    const draft = TasksetDraftSchema.parse(input.draft);
    const taskset = TasksetSchema.parse(input.taskset);
    const write = this.writeQueue.then(() => {
      const row = this.database.get<PayloadRow>("SELECT payload FROM taskset_drafts WHERE id = ?", [draft.id]);
      if (!row) throw new Error("Taskset draft was deleted before publication.");
      const pointer = TasksetDraftPointerSchema.parse(JSON.parse(row.payload));
      if (pointer.profileId !== draft.profileId || taskset.profileId !== draft.profileId) throw new Error("Taskset publication belongs to another Profile.");
      if (contentHash(pointer.modelScope) !== contentHash(draft.modelScope)) throw new Error("Taskset draft Model ownership cannot change.");
      if (pointer.status === "published" && pointer.publishedTasksetRef) {
        const ref = pointer.publishedTasksetRef;
        const saved = this.database.get<PayloadRow>("SELECT payload FROM taskset_revisions WHERE taskset_id = ? AND revision = ? AND content_hash = ?", [ref.id, ref.revision, ref.contentHash]);
        if (!saved) throw new Error("Published draft lost its immutable Taskset revision.");
        return { draft: TasksetDraftSchema.parse({ ...draft, status: pointer.status, revision: pointer.revision, publishedTasksetRef: ref, updatedAt: pointer.updatedAt }), taskset: TasksetSchema.parse(JSON.parse(saved.payload)) };
      }
      if (pointer.revision !== draft.revision || taskset.metadata.sourcePackageHash !== input.packageHash) throw new Error("Taskset draft changed before publication. Refresh before publishing.");
      const preparedSource = pointer.modelScope?.source;
      if (preparedSource && (taskset.id !== preparedSource.tasksetId || taskset.revision !== preparedSource.tasksetRevision
        || contentHash(taskset.metadata.modelTasksetAuthoring) !== contentHash(preparedSource.lineage))) throw new Error("Taskset publication differs from its retained source preparation.");
      const published = TasksetDraftSchema.parse({ ...draft, status: "published", revision: draft.revision + 1,
        publishedTasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash }, updatedAt: new Date().toISOString() });
      const next = TasksetDraftPointerSchema.parse({ ...pointer, status: published.status, revision: published.revision,
        publishedTasksetRef: published.publishedTasksetRef, updatedAt: published.updatedAt });
      saveTasksetRevision(this.database, taskset, () => {
        selectTasksetDraftModel(this.database, draft, taskset);
        const current = this.database.get<{ revision: number }>("SELECT revision FROM taskset_drafts WHERE id = ?", [draft.id]);
        if (current?.revision !== draft.revision) throw new Error("Taskset draft changed during publication.");
        this.database.run("UPDATE taskset_drafts SET status = ?, revision = ?, payload = ?, updated_at = ? WHERE id = ?",
          [next.status, next.revision, JSON.stringify(next), next.updatedAt, draft.id]);
      });
      return { draft: published, taskset };
    });
    this.writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async getTasksetDraft(id: string): Promise<TasksetDraft | null> {
    const stored = await this.getParsedPayload(
      "SELECT payload FROM taskset_drafts WHERE id = ?",
      [id],
      (value) => value,
    );
    return stored === null ? null : this.draftFromStoredPayload(stored);
  }

  async listTasksetDrafts(profileId?: string): Promise<TasksetDraft[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      profileId
        ? "SELECT payload FROM taskset_drafts WHERE profile_id = ? ORDER BY updated_at DESC"
        : "SELECT payload FROM taskset_drafts ORDER BY updated_at DESC",
      profileId ? [profileId] : [],
    );
    return Promise.all(rows.map((row) =>
      this.draftFromStoredPayload(JSON.parse(row.payload) as unknown)
    ));
  }

  async getTasksetDraftWorkspace(id: string): Promise<TasksetDraftWorkspace | null> {
    const stored = await this.getParsedPayload(
      "SELECT payload FROM taskset_drafts WHERE id = ?",
      [id],
      (value) => value,
    );
    if (stored === null) return null;
    const pointer = await this.pointerFromStoredPayload(stored);
    return {
      draftId: pointer.id,
      workspacePath: pointer.workspacePath,
      packageHash: await hashTasksetDraftPackage(pointer.workspacePath),
    };
  }

  async deleteTasksetDraft(id: string): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const workspacePath = this.workspacePath(id);
      const recoverablePath = `${workspacePath}.delete-${randomUUID()}`;
      let movedWorkspace = false;
      try {
        await rename(workspacePath, recoverablePath);
        movedWorkspace = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        this.database.exec("BEGIN IMMEDIATE");
        try {
          this.database.run("DELETE FROM taskset_drafts WHERE id = ?", [id]);
          this.database.run("UPDATE model_taskset_draft_operations SET state = 'deleted' WHERE draft_id = ?", [id]);
          this.database.exec("COMMIT");
        } catch (error) { this.database.exec("ROLLBACK"); throw error; }
      } catch (error) {
        if (movedWorkspace) await rename(recoverablePath, workspacePath).catch(() => undefined);
        throw error;
      }
      if (movedWorkspace) await rm(recoverablePath, { recursive: true, force: true });
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private workspacePath(id: string): string {
    const stableId = contentHash(id).slice(0, 24);
    return path.join(
      this.home,
      "workspaces",
      "tasksets",
      `taskset-${stableId}`,
    );
  }

  private async draftFromStoredPayload(value: unknown): Promise<TasksetDraft> {
    const pointer = await this.pointerFromStoredPayload(value);
    const workspaceDraft = await readTasksetDraftPackage(pointer.workspacePath);
    return TasksetDraftSchema.parse({
      ...workspaceDraft,
      id: pointer.id,
      profileId: pointer.profileId,
      modelScope: pointer.modelScope,
      status: pointer.status,
      revision: pointer.revision,
      publishedTasksetRef: pointer.publishedTasksetRef,
      createdAt: pointer.createdAt,
      updatedAt: pointer.updatedAt,
    });
  }

  private async pointerFromStoredPayload(value: unknown): Promise<TasksetDraftPointer> {
    const pointer = TasksetDraftPointerSchema.safeParse(value);
    if (pointer.success) return pointer.data;

    const legacyDraft = TasksetDraftSchema.parse(value);
    await this.saveTasksetDraft(legacyDraft);
    const migrated = await this.getParsedPayload(
      "SELECT payload FROM taskset_drafts WHERE id = ?",
      [legacyDraft.id],
      TasksetDraftPointerSchema.parse,
    );
    if (!migrated) throw new Error(`Taskset draft ${legacyDraft.id} migration failed.`);
    return migrated;
  }

  private async savePointer(pointer: TasksetDraftPointer, withinWriteQueue = false): Promise<void> {
    await (withinWriteQueue ? this.run.bind(this) : this.upsertPayload.bind(this))(
      `INSERT INTO taskset_drafts (id, profile_id, status, revision, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         profile_id = excluded.profile_id,
         status = excluded.status,
         revision = excluded.revision,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        pointer.id,
        pointer.profileId,
        pointer.status,
        pointer.revision,
        JSON.stringify(pointer),
        pointer.createdAt,
        pointer.updatedAt,
      ],
    );
  }
}

async function assertRegularPackageTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Taskset packages cannot contain symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertRegularPackageTree(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Taskset packages may contain only files and directories: ${entryPath}`);
    }
  }
}
