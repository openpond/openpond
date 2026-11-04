import { z } from "zod";
import { ExperimentDraftSchema, parseAndVerifyExperimentDraft } from "./training-experiment-setup.js";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(240);
/** Canonical saved-draft pointer shared by chat hosts and headless clients.
 * A pointer grants no access; each host reauthorizes the current document. */
export const StoredExperimentDraftReferenceSchema = z.object({
  id: Id, teamId: Id, apiOrigin: z.url().max(2000),
}).strict();
export type StoredExperimentDraftReference = z.infer<typeof StoredExperimentDraftReferenceSchema>;

export const ExperimentDraftRecordSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraftRecord.v1"),
  id: Id, teamId: Id, ownerUserId: Id, projectId: Id.nullable(),
  revision: z.number().int().positive(), status: z.enum(["draft", "archived"]),
  draft: ExperimentDraftSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((record, context) => {
  if (record.id !== record.draft.id)
    context.addIssue({ code: "custom", path: ["id"], message: "The stored draft identity does not match its document." });
});
export const ExperimentDraftSaveSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraftSave.v1"),
  teamId: Id, operationId: Id, expectedRevision: z.number().int().nonnegative(),
  projectId: Id.nullable().default(null), draft: ExperimentDraftSchema,
}).strict();
export const ExperimentDraftArchiveSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraftArchive.v1"),
  teamId: Id, operationId: Id, expectedRevision: z.number().int().positive(),
}).strict();
export const ExperimentDraftReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraftReceipt.v1"),
  operationId: Id, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  record: ExperimentDraftRecordSchema,
}).strict();
export const ExperimentDraftListQuerySchema = z.object({
  projectId: Id.optional(), search: z.string().trim().max(1000).optional(),
  archived: z.boolean().default(false), cursor: z.string().min(1).max(2000).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
export const ExperimentDraftPageSchema = z.object({
  schemaVersion: z.literal("openpond.experimentDraftPage.v1"),
  teamId: Id, ownerUserId: Id, projectId: Id.nullable(),
  items: z.array(ExperimentDraftRecordSchema).max(100),
  nextCursor: z.string().min(1).max(2000).nullable(),
}).strict();
export type ExperimentDraftRecord = z.infer<typeof ExperimentDraftRecordSchema>;
export type ExperimentDraftSave = z.input<typeof ExperimentDraftSaveSchema>;
export type ExperimentDraftArchive = z.infer<typeof ExperimentDraftArchiveSchema>;
export type ExperimentDraftReceipt = z.infer<typeof ExperimentDraftReceiptSchema>;
export type ExperimentDraftListQuery = z.input<typeof ExperimentDraftListQuerySchema>;
export type ExperimentDraftPage = z.infer<typeof ExperimentDraftPageSchema>;

export async function parseAndVerifyExperimentDraftRecord(raw: unknown) {
  const record = ExperimentDraftRecordSchema.parse(raw);
  const { contentHash, ...content } = record;
  if (contentHash !== await canonicalSha256(content))
    throw new OpenPondProtocolError("experiment_draft_hash_mismatch", "The saved draft differs from its retained document.");
  await parseAndVerifyExperimentDraft(record.draft, {teamId: record.teamId});
  return record;
}
export async function parseAndVerifyExperimentDraftReceipt(raw: unknown) {
  const receipt = ExperimentDraftReceiptSchema.parse(raw);
  return { ...receipt, record: await parseAndVerifyExperimentDraftRecord(receipt.record) };
}
function mismatch(message: string): never {
  throw new OpenPondProtocolError("experiment_draft_scope_mismatch", message);
}
export function createExperimentDraftClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  async function write(path: string, value: unknown) {
    const body = canonicalJson(value);
    if (new TextEncoder().encode(body).byteLength > 32_768)
      throw new OpenPondProtocolError("experiment_draft_too_large", "Drafts contain settings and references, not model or dataset bytes.");
    return parseAndVerifyExperimentDraftReceipt(await request(path, { method: "POST", body }));
  }
  return {
    async saveExperimentDraft(raw: ExperimentDraftSave): Promise<ExperimentDraftReceipt> {
      const input = ExperimentDraftSaveSchema.parse(raw);
      await parseAndVerifyExperimentDraft(input.draft, {teamId: input.teamId});
      const receipt = await write("/v1/training/experiment-drafts", input);
      const row = receipt.record;
      if (receipt.operationId !== input.operationId || receipt.requestHash !== await canonicalSha256(input) ||
          row.teamId !== input.teamId || row.id !== input.draft.id || row.projectId !== input.projectId ||
          row.revision !== input.expectedRevision + 1 || row.status !== "draft" || canonicalJson(row.draft) !== canonicalJson(input.draft))
        mismatch("The service saved a different draft, Project or revision.");
      return receipt;
    },
    async getExperimentDraft(teamId: string, id: string): Promise<ExperimentDraftRecord> {
      const team = Id.parse(teamId), identity = Id.parse(id);
      const row = await parseAndVerifyExperimentDraftRecord(await request(`/v1/training/experiment-drafts/${encodeURIComponent(identity)}?${new URLSearchParams({ teamId: team })}`));
      if (row.teamId !== team || row.id !== identity) mismatch("The service returned another draft or workspace.");
      return row;
    },
    async listExperimentDrafts(teamId: string, raw: ExperimentDraftListQuery = {}): Promise<ExperimentDraftPage> {
      const team = Id.parse(teamId), query = ExperimentDraftListQuerySchema.parse(raw);
      const params = new URLSearchParams({ teamId: team });
      for (const [key, value] of Object.entries(query)) params.set(key, String(value));
      const page = ExperimentDraftPageSchema.parse(await request(`/v1/training/experiment-drafts?${params}`));
      if (page.teamId !== team || page.projectId !== (query.projectId ?? null) || page.items.length > query.limit ||
          new Set(page.items.map(row => row.id)).size !== page.items.length || query.cursor && page.nextCursor === query.cursor)
        mismatch("The draft list returned another scope or invalid page.");
      for (const rawRow of page.items) {
        const row = await parseAndVerifyExperimentDraftRecord(rawRow);
        if (row.teamId !== team || row.ownerUserId !== page.ownerUserId || query.projectId && row.projectId !== query.projectId ||
            row.status !== (query.archived ? "archived" : "draft")) mismatch("The draft list contains another owner, Project or state.");
      }
      return page;
    },
    async archiveExperimentDraft(id: string, raw: ExperimentDraftArchive): Promise<ExperimentDraftReceipt> {
      const identity = Id.parse(id), input = ExperimentDraftArchiveSchema.parse(raw);
      const receipt = await write(`/v1/training/experiment-drafts/${encodeURIComponent(identity)}/archive`, input);
      if (receipt.operationId !== input.operationId || receipt.requestHash !== await canonicalSha256({ id: identity, ...input }) ||
          receipt.record.teamId !== input.teamId || receipt.record.id !== identity ||
          receipt.record.revision !== input.expectedRevision + 1 || receipt.record.status !== "archived")
        mismatch("The service archived another draft or revision.");
      return receipt;
    },
  };
}
