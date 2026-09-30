import { z } from "zod";
import { TasksetDraftWorkspaceSchema } from "./taskset-draft-workspace.js";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";
export { compileTasksetDraftWorkspace } from "./taskset-draft-package-compiler.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DatasetWorkspaceListQuerySchema = z.object({ cursor: z.string().trim().min(1).max(2_000).optional(), projectId: Id.optional(), search: z.string().trim().max(100).optional(), sort: z.enum(["id", "name", "updated"]).default("id"), limit: z.number().int().min(1).max(100).default(100) }).strict();
export const DatasetWorkspaceWriteSchema = z.object({
  operationId: Id, expectedRevision: z.number().int().nonnegative(), originProjectId: Id.optional(), workspace: TasksetDraftWorkspaceSchema,
  ownerScope: z.enum(["workspace", "personal"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.workspace.draft.modelScope !== null) ctx.addIssue({ code: "custom", message: "Independent datasets cannot carry Model-owned draft preparation." });
  if (value.workspace.draft.status !== "draft") ctx.addIssue({ code: "custom", message: "Only draft workspaces can be saved." });
});
export const DatasetWorkspaceReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.datasetWorkspaceReceipt.v1"), teamId: Id, datasetId: Id,
  revision: z.number().int().positive(), originProjectId: Id.optional(), workspace: TasksetDraftWorkspaceSchema,
  ownerScope: z.enum(["workspace", "personal"]).optional(),
  publication: z.object({ tasksetId: Id, release: TasksetCatalogReleaseRefSchema, packageHash: Hash }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.workspace.draft.id !== value.datasetId || value.workspace.draft.profileId !== value.teamId || value.workspace.draft.revision !== value.revision || value.workspace.draft.modelScope !== null) ctx.addIssue({ code: "custom", message: "Dataset workspace scope/revision mismatch." });
});
export const DatasetWorkspacePublishSchema = z.object({ operationId: Id, expectedRevision: z.number().int().positive(), workspaceHash: Hash, packageHash: Hash }).strict();
export const DatasetWorkspaceBeginVersionSchema = z.object({ operationId: Id, expectedRevision: z.number().int().positive() }).strict();
export const DatasetWorkspaceVersionsSchema = z.object({ teamId: Id, datasetId: Id, items: z.array(z.object({
  workspaceRevision: z.number().int().positive(), publication: DatasetWorkspaceReceiptSchema.shape.publication.unwrap(), publishedAt: z.iso.datetime(),
}).strict()).max(25), nextBeforeRevision: z.number().int().positive().nullable() }).strict();
export type DatasetWorkspaceReceipt = z.infer<typeof DatasetWorkspaceReceiptSchema>;

export const DatasetWorkspaceListSchema = z.object({ teamId: Id, datasets: z.array(z.object({
  id: Id, revision: z.number().int().positive(), originProjectId: Id.optional(), name: z.string(), status: z.enum(["draft", "published"]),
  ownerScope: z.enum(["workspace", "personal"]).optional(),
  publication: DatasetWorkspaceReceiptSchema.shape.publication, updatedAt: z.string().datetime(),
}).strict()).max(100), nextCursor: z.string().trim().min(1).max(2_000).nullable() }).strict();
export const DatasetWorkspaceValidationSchema = z.object({ teamId: Id, datasetId: Id, revision: z.number().int().positive(), workspaceHash: Hash, packageHash: Hash, release: TasksetCatalogReleaseRefSchema }).strict();
