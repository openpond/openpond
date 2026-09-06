import { assertBoundedTaskJson } from "../task-schema.js";
import { AuthoringDraftSchema, type AuthoringDraftInput } from "./authoring.js";
import { LearningDomainError } from "./errors.js";
import { learningRef, sameLearningRef, sealLearningContent, type LearningRevisionRef } from "./contracts.js";
import { requireLearningRelease, type LearningResourcePointer, type LearningTransaction } from "./repository.js";
import type { LearningCommand } from "./operations.js";

export async function saveAuthoringDraft(tx: LearningTransaction, input: { draft: AuthoringDraftInput; expectedRevision: number }, now: string) {
  // A 100-record page remains below the common 16 MiB response limit.
  assertBoundedTaskJson(input.draft, 131_072);
  const previous = await tx.get("draft", input.draft.id);
  if (previous && (previous.status !== "draft" || previous.targetId !== input.draft.targetId || previous.targetKind !== input.draft.targetKind || (previous.baseRelease === null ? input.draft.baseRelease !== null : input.draft.baseRelease === null || !sameLearningRef(previous.baseRelease, input.draft.baseRelease)))) throw new LearningDomainError("authoring_draft_identity_conflict", 409);
  if (input.draft.baseRelease) {
    if (input.draft.baseRelease.id !== input.draft.targetId) throw new LearningDomainError("authoring_draft_base_mismatch", 422);
    await requireLearningRelease(tx, input.draft.targetKind, input.draft.baseRelease);
  }
  const draft = AuthoringDraftSchema.parse(sealLearningContent({ ...input.draft, schemaVersion: "openpond.authoringDraft.v1", revision: input.expectedRevision + 1, status: "draft", publishedRelease: null, createdAt: previous?.createdAt ?? now, updatedAt: now }));
  await tx.put("draft", draft, input.expectedRevision, { parentId: draft.targetKind, status: draft.status });
  return { kind: "draft" as const, id: draft.id, revision: draft.revision };
}

export async function archiveAuthoringDraft(tx: LearningTransaction, ref: LearningRevisionRef, now: string) {
  const draft = await currentDraft(tx, ref);
  const { contentHash: _hash, ...content } = draft;
  const archived = AuthoringDraftSchema.parse(sealLearningContent({ ...content, revision: draft.revision + 1, status: "archived", updatedAt: now }));
  await tx.put("draft", archived, draft.revision, { parentId: draft.targetKind, status: archived.status });
  return { kind: "draft" as const, id: archived.id, revision: archived.revision };
}

export async function finalizeAuthoringDraft(tx: LearningTransaction, input: Extract<LearningCommand, { action: "publish" | "publish_resources" }>, published: LearningResourcePointer[], now: string) {
  const finalization = input.finalizeDraft;
  if (!finalization) return null;
  const draft = await currentDraft(tx, finalization.draft);
  if (draft.targetKind !== finalization.targetKind || draft.targetId !== finalization.release.id || finalization.release.revision !== (draft.baseRelease?.revision ?? 0) + 1 || !published.some(value => value.kind === finalization.targetKind && value.id === finalization.release.id && value.revision === finalization.release.revision)) throw new LearningDomainError("authoring_draft_publication_mismatch", 422);
  await requireLearningRelease(tx, finalization.targetKind, finalization.release);
  const { contentHash: _hash, ...content } = draft;
  const completed = AuthoringDraftSchema.parse(sealLearningContent({ ...content, revision: draft.revision + 1, status: "published", publishedRelease: finalization.release, updatedAt: now }));
  await tx.put("draft", completed, draft.revision, { parentId: draft.targetKind, status: completed.status });
  return { kind: "draft" as const, id: completed.id, revision: completed.revision };
}

async function currentDraft(tx: LearningTransaction, ref: LearningRevisionRef) {
  const draft = await requireLearningRelease(tx, "draft", ref);
  const current = await tx.get("draft", ref.id);
  if (!current || !sameLearningRef(learningRef(current), ref)) throw new LearningDomainError("authoring_draft_revision_stale", 409);
  if (draft.status !== "draft") throw new LearningDomainError("authoring_draft_closed", 409);
  return draft;
}
