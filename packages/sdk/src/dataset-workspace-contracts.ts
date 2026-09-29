import { z } from "zod";
import { TasksetDraftWorkspaceSchema } from "./taskset-draft-workspace.js";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";
export { compileTasksetDraftWorkspace } from "./taskset-draft-package-compiler.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DatasetWorkspaceWriteSchema = z.object({
  operationId: Id, expectedRevision: z.number().int().nonnegative(), workspace: TasksetDraftWorkspaceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.workspace.draft.modelScope !== null) ctx.addIssue({ code: "custom", message: "Independent datasets cannot carry Model-owned draft preparation." });
  if (value.workspace.draft.status !== "draft") ctx.addIssue({ code: "custom", message: "Only draft workspaces can be saved." });
});
export const DatasetWorkspaceReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.datasetWorkspaceReceipt.v1"), teamId: Id, datasetId: Id,
  revision: z.number().int().positive(), workspace: TasksetDraftWorkspaceSchema,
  publication: z.object({ tasksetId: Id, release: TasksetCatalogReleaseRefSchema, packageHash: Hash }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.workspace.draft.id !== value.datasetId || value.workspace.draft.profileId !== value.teamId || value.workspace.draft.revision !== value.revision || value.workspace.draft.modelScope !== null) ctx.addIssue({ code: "custom", message: "Dataset workspace scope/revision mismatch." });
});
export const DatasetWorkspacePublishSchema = z.object({ operationId: Id, expectedRevision: z.number().int().positive(), workspaceHash: Hash, packageHash: Hash }).strict();
export type DatasetWorkspaceReceipt = z.infer<typeof DatasetWorkspaceReceiptSchema>;

export const DatasetWorkspaceListSchema = z.object({ teamId: Id, datasets: z.array(z.object({
  id: Id, revision: z.number().int().positive(), name: z.string(), status: z.enum(["draft", "published"]),
  publication: DatasetWorkspaceReceiptSchema.shape.publication, updatedAt: z.string().datetime(),
}).strict()).max(100), nextCursor: Id.nullable() }).strict();
export const DatasetWorkspaceValidationSchema = z.object({ teamId: Id, datasetId: Id, revision: z.number().int().positive(), workspaceHash: Hash, packageHash: Hash, release: TasksetCatalogReleaseRefSchema }).strict();
