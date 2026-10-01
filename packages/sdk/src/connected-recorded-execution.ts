import { z } from "zod";
import { ImmutableReleaseRefSchema, contentHash } from "@openpond/harness";
import { ExperimentManifestSchema } from "@openpond/evals/experiments";
import { TaskRecordSchema } from "@openpond/evals/tasksets";
import { ConnectedCaseRefSchema } from "./connected-evidence-contracts.js";

const Id = z.string().min(1).max(200), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ConnectedRecordedExecutionRequestSchema = z.object({ operationId: Id, name: z.string().trim().min(1).max(500),
  projectId: Id, dataset: ImmutableReleaseRefSchema.extend({ revision: z.number().int().positive() }).strict(),
  caseIds: z.array(Id).min(1).max(10_000) }).strict().superRefine((value, ctx) => {
  if (new Set(value.caseIds).size !== value.caseIds.length) ctx.addIssue({ code: "custom", message: "Select each case once." });
});
export const ConnectedRecordedSourceSchema = ConnectedCaseRefSchema.extend({ inputHash: Hash, outputHash: Hash.nullable(),
  task: TaskRecordSchema, taskHash: Hash }).strict();
export const ConnectedRecordedExecutionSchema = z.object({ schemaVersion: z.literal("openpond.connectedRecordedExecution.v1"),
  id: Id, teamId: Id, ownerUserId: Id, request: ConnectedRecordedExecutionRequestSchema,
  manifest: ExperimentManifestSchema, sources: z.array(ConnectedRecordedSourceSchema).min(1).max(10_000), contentHash: Hash }).strict();
export type ConnectedRecordedExecution = z.infer<typeof ConnectedRecordedExecutionSchema>;
export function verifyConnectedRecordedExecution(raw: unknown) {
  const value = ConnectedRecordedExecutionSchema.parse(raw), { contentHash: actual, ...body } = value;
  const { contentHash: manifestHash, ...manifest } = value.manifest;
  if (contentHash(body) !== actual || contentHash(manifest) !== manifestHash || value.manifest.teamId !== value.teamId
    || value.manifest.id !== value.id || value.manifest.operationId !== value.request.operationId
    || contentHash(value.manifest.dataset) !== contentHash(value.request.dataset)
    || value.sources.length !== value.request.caseIds.length || value.sources.length !== value.manifest.population.length
    || value.sources.some((source, index) => source.taskHash !== contentHash(source.task) || source.task.id !== value.request.caseIds[index]
      || source.boundaryId !== source.task.id || value.manifest.population[index]?.caseId !== source.boundaryId))
    throw new Error("Recorded execution identity or population integrity failed.");
  return value;
}

export const ConnectedRecordedListRequestSchema = z.object({ projectId: Id.optional(), cursor: Id.optional(), limit: z.number().int().min(1).max(50).default(20) }).strict();
export const ConnectedRecordedSummarySchema = z.object({ id: Id, teamId: Id, ownerUserId: Id, projectId: Id,
  name: z.string().min(1).max(500), dataset: ConnectedRecordedExecutionRequestSchema.shape.dataset,
  manifestHash: Hash, contentHash: Hash, caseCount: z.number().int().min(1).max(10_000), createdAt: z.string().datetime() }).strict();
export const ConnectedRecordedListSchema = z.object({ teamId: Id, items: z.array(ConnectedRecordedSummarySchema).max(50), nextCursor: Id.nullable() }).strict();
