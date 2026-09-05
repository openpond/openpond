import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  TasksetDraftSchema,
  type Taskset,
  type TasksetDraft,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import {
  hashTasksetDraftPackage,
  readTasksetDraftPackage,
  buildTaskset,
  sha256,
  writeTasksetDraftPackage,
} from "@openpond/taskset-sdk";
import { z } from "zod";

import type { PayloadRow } from "../types.js";
import { SqlitePreferenceComparisonStore } from "./store-preference-comparison.js";

const TasksetDraftPointerSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetDraftPointer.v1"),
  id: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
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
  async saveTasksetDraft(draftInput: TasksetDraft): Promise<TasksetDraft> {
    const draft = TasksetDraftSchema.parse(draftInput);
    const workspacePath = this.workspacePath(draft.id);
    const written = await writeTasksetDraftPackage(draft, workspacePath);
    const persistedDraft = written.draft;
    const pointer = TasksetDraftPointerSchema.parse({
      schemaVersion: "openpond.tasksetDraftPointer.v1",
      id: persistedDraft.id,
      profileId: persistedDraft.profileId,
      status: persistedDraft.status,
      revision: persistedDraft.revision,
      workspacePath,
      packageHash: await hashTasksetDraftPackage(workspacePath),
      publishedTasksetRef: persistedDraft.publishedTasksetRef,
      createdAt: persistedDraft.createdAt,
      updatedAt: persistedDraft.updatedAt,
    });
    await this.savePointer(pointer);
    return persistedDraft;
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
  }): Promise<string> {
    const workspace = await this.getTasksetDraftWorkspace(input.draftId);
    if (!workspace) {
      throw new Error(`Taskset draft ${input.draftId} workspace was not found.`);
    }
    await assertRegularPackageTree(workspace.workspacePath);
    const tasksetRoot = path.join(
      this.home,
      "training",
      "tasksets",
      input.taskset.id,
    );
    await mkdir(tasksetRoot, { recursive: true });
    await cp(workspace.workspacePath, tasksetRoot, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    await buildTaskset(input.taskset, tasksetRoot);
    await verifyPublishedTasksetAssets(tasksetRoot, input.taskset);
    return tasksetRoot;
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
    const workspacePath = this.workspacePath(id);
    const recoverablePath = `${workspacePath}.delete-${randomUUID()}`;
    let movedWorkspace = false;
    try {
      await rename(workspacePath, recoverablePath);
      movedWorkspace = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const write = this.writeQueue.then(async () => {
      try {
        await this.run("DELETE FROM taskset_drafts WHERE id = ?", [id]);
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

  private async savePointer(pointer: TasksetDraftPointer): Promise<void> {
    await this.upsertPayload(
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

async function verifyPublishedTasksetAssets(
  tasksetRoot: string,
  taskset: Taskset,
): Promise<void> {
  const assetRoot = path.resolve(tasksetRoot, "assets");
  for (const task of taskset.tasks) {
    for (const asset of task.assets ?? []) {
      const assetPath = path.resolve(tasksetRoot, asset.artifactRef);
      if (assetPath === assetRoot || !assetPath.startsWith(`${assetRoot}${path.sep}`)) {
        throw new Error(`Taskset asset ${asset.id} escapes the package assets directory.`);
      }
      const status = await lstat(assetPath);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`Taskset asset ${asset.id} is not a regular file.`);
      }
      const bytes = await readFile(assetPath);
      if (bytes.byteLength !== asset.sizeBytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`Taskset asset ${asset.id} does not match its immutable manifest.`);
      }
    }
  }
}
