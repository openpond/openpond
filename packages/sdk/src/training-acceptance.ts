import { z } from "zod";
import { assertAcceptanceGroupSnapshot, AcceptanceGroupSnapshotSchema } from "@openpond/evals/learning";
import { ModelProjectImmutableRefSchema } from "./model-projects.js";
import { OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(240);
export const TrainingAcceptanceGroupReferenceSchema = ModelProjectImmutableRefSchema.extend({ revision: z.number().int().positive() }).strict();
export const TrainingAcceptanceGroupSummarySchema = TrainingAcceptanceGroupReferenceSchema.extend({
  teamId: Id, jobId: Id,
  plan: ModelProjectImmutableRefSchema,
  baseline: ModelProjectImmutableRefSchema,
  candidate: ModelProjectImmutableRefSchema,
  state: AcceptanceGroupSnapshotSchema.shape.state,
  updatedAt: z.string().datetime(),
}).strict();
export const TrainingAcceptanceGroupPageSchema = z.object({
  schemaVersion: z.literal("openpond.trainingAcceptanceGroupPage.v1"),
  teamId: Id, jobId: Id, groups: z.array(TrainingAcceptanceGroupSummarySchema).max(100), nextCursor: Id.nullable(),
}).strict();
export const TrainingAcceptanceGroupQuerySchema = z.object({
  cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(25),
}).strict();
export type TrainingAcceptanceGroupReference = z.infer<typeof TrainingAcceptanceGroupReferenceSchema>;
export type TrainingAcceptanceGroupSummary = z.infer<typeof TrainingAcceptanceGroupSummarySchema>;
export type TrainingAcceptanceGroupPage = z.infer<typeof TrainingAcceptanceGroupPageSchema>;
export type TrainingAcceptanceGroupQuery = z.input<typeof TrainingAcceptanceGroupQuerySchema>;
export type TrainingAcceptanceTarget = { teamId: string; jobId: string };

/** Read retained evidence. These operations do not create, retry or dispatch checks. */
export function createTrainingAcceptanceClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const route = (target: TrainingAcceptanceTarget) => {
    Id.parse(target.teamId);
    return `/v1/training/jobs/${encodeURIComponent(Id.parse(target.jobId))}/acceptance-groups`;
  };
  return {
    async acceptanceGroups(target: TrainingAcceptanceTarget, input: TrainingAcceptanceGroupQuery = {}) {
      const query = TrainingAcceptanceGroupQuerySchema.parse(input);
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor) params.set("cursor", query.cursor);
      const page = TrainingAcceptanceGroupPageSchema.parse(await request(`${route(target)}?${params}`));
      if (page.teamId !== target.teamId || page.jobId !== target.jobId || page.groups.length > query.limit ||
          page.groups.some(group => group.teamId !== target.teamId || group.jobId !== target.jobId || (query.cursor && group.id <= query.cursor)) ||
          new Set(page.groups.map(group => group.id)).size !== page.groups.length ||
          (page.nextCursor !== null && page.nextCursor !== page.groups.at(-1)?.id))
        throw new OpenPondProtocolError("acceptance_group_scope_mismatch", "Acceptance groups do not match the requested workspace, job or cursor.");
      return page;
    },
    async acceptanceGroup(target: TrainingAcceptanceTarget, groupId: string, expected?: TrainingAcceptanceGroupReference) {
      const reference = expected ? TrainingAcceptanceGroupReferenceSchema.parse({ id: expected.id, revision: expected.revision, contentHash: expected.contentHash }) : null;
      if (reference && reference.id !== groupId) throw new OpenPondProtocolError("acceptance_group_identity_mismatch", "The retained group reference differs from the requested group.");
      const suffix = reference ? `?revision=${reference.revision}` : "";
      const snapshot = assertAcceptanceGroupSnapshot(await request(`${route(target)}/${encodeURIComponent(Id.parse(groupId))}${suffix}`));
      if (snapshot.manifest.teamId !== target.teamId || snapshot.manifest.trainingJob.id !== target.jobId || snapshot.manifest.id !== groupId ||
          (reference && (snapshot.revision !== reference.revision || snapshot.contentHash !== reference.contentHash)))
        throw new OpenPondProtocolError("acceptance_group_identity_mismatch", "Acceptance evidence does not match the requested workspace, job or retained revision.");
      return snapshot;
    },
  };
}
