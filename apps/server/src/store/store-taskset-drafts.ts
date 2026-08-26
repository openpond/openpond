import path from "node:path";

import {
  TasksetDraftSchema,
  type TasksetDraft,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import {
  hashTasksetDraftPackage,
  readTasksetDraftPackage,
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
    const write = this.writeQueue.then(() =>
      this.run("DELETE FROM taskset_drafts WHERE id = ?", [id]));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private workspacePath(id: string): string {
    const stableId = contentHash(id).slice(0, 24);
    return path.join(
      path.dirname(this.storePath),
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
