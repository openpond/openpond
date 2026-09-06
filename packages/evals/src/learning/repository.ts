import { z } from "zod";
import { contentHash } from "@openpond/harness";

import { assertLearningContentHash, LearningSourceSchema, TaskAdmissionDecisionSchema, TaskBatchSchema, TaskDefinitionSchema, TaskEvidenceSchema, TaskFeedbackSchema, TaskGradeRunSchema, LearningPolicySchema, LearningIterationSchema, type LearningRevisionRef } from "./contracts.js";
import { RewardBindingSchema, RewardReleaseSchema } from "../rewards.js";
import { TasksetReleaseSchema } from "../tasksets.js";
import { LearningDomainError } from "./errors.js";
import { LearningTextAssetSchema } from "./assets.js";

export const learningResourceSchemas = {
  asset: LearningTextAssetSchema,
  definition: TaskDefinitionSchema, reward: RewardReleaseSchema, binding: RewardBindingSchema,
  source: LearningSourceSchema, evidence: TaskEvidenceSchema, feedback: TaskFeedbackSchema,
  decision: TaskAdmissionDecisionSchema, batch: TaskBatchSchema, policy: LearningPolicySchema,
  iteration: LearningIterationSchema, grade: TaskGradeRunSchema, package: TasksetReleaseSchema,
} as const;
export type LearningResourceKind = keyof typeof learningResourceSchemas;
export const LearningResourceKindSchema = z.enum(Object.keys(learningResourceSchemas) as [LearningResourceKind, ...LearningResourceKind[]]);
export type LearningResourceFor<K extends LearningResourceKind> = z.infer<(typeof learningResourceSchemas)[K]>;
export type LearningStoredResource = LearningResourceFor<LearningResourceKind>;

export type LearningResourcePointer = { kind: LearningResourceKind; id: string; revision: number };
export type LearningOperationReceipt = { requestHash: string; resources: LearningResourcePointer[] };
export type LearningResourceQuery = { parentId?: string; status?: string; afterId?: string; limit: number };
export type LearningResourcePage<K extends LearningResourceKind> = { items: LearningResourceFor<K>[]; nextCursor: string | null };

/** Transactions must serialize mutations within a scope and roll back atomically. */
export interface LearningTransaction {
  get<K extends LearningResourceKind>(kind: K, id: string, revision?: number): Promise<LearningResourceFor<K> | null>;
  put<K extends LearningResourceKind>(kind: K, resource: LearningResourceFor<K>, expectedRevision: number, index?: { parentId?: string; status?: string }): Promise<void>;
  list<K extends LearningResourceKind>(kind: K, query: LearningResourceQuery): Promise<LearningResourcePage<K>>;
  operation(id: string): Promise<LearningOperationReceipt | null>;
  saveOperation(id: string, receipt: LearningOperationReceipt): Promise<void>;
  familySplit(namespace: string, kind: "family" | "input", key: string): Promise<string | null>;
  reserveFamilySplit(namespace: string, kind: "family" | "input", key: string, split: string): Promise<void>;
}
export interface LearningRepository {
  transaction<T>(scope: string, callback: (transaction: LearningTransaction) => Promise<T>): Promise<T>;
}

export class LearningConflictError extends LearningDomainError {
  constructor(readonly kind: string, readonly id: string, readonly expectedRevision: number, readonly currentRevision: number) {
    super("learning_revision_conflict", 409, `Revision conflict for ${kind} ${id}: expected ${expectedRevision}, current ${currentRevision}.`);
    this.name = "LearningConflictError";
  }
}

export async function requireLearningResource<K extends LearningResourceKind>(transaction: LearningTransaction, kind: K, id: string, revision?: number): Promise<LearningResourceFor<K>> {
  const resource = await transaction.get(kind, id, revision);
  if (!resource) throw new LearningDomainError("learning_resource_not_found", 404, `${kind}:${id}`);
  return learningResourceSchemas[kind].parse(resource) as LearningResourceFor<K>;
}
export async function requireLearningRelease<K extends LearningResourceKind>(transaction: LearningTransaction, kind: K, ref: LearningRevisionRef): Promise<LearningResourceFor<K>> {
  const resource = await requireLearningResource(transaction, kind, ref.id, ref.revision);
  if (!("contentHash" in resource) || resource.contentHash !== ref.contentHash) throw new LearningDomainError("learning_release_hash_mismatch", 409, `${kind}:${ref.id}`);
  assertLearningContentHash(resource);
  return resource;
}
export function learningEvidenceId(sourceId: string, exampleId: string, attemptId: string): string {
  return `evidence-${contentHash([sourceId, exampleId, attemptId])}`;
}
export function learningOperationId(actorId: string, operationId: string): string {
  return contentHash([actorId, operationId]);
}
