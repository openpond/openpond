import { z } from "zod";
import { DatasetWorkspaceReceiptSchema } from "./dataset-workspace-contracts.js";
export const DatasetWorkspaceOperationKindSchema = z.enum(["create", "save", "publish", "begin_version"]);
export const DatasetWorkspaceOperationResultSchema = z.object({ operationId: z.string().trim().min(1).max(240), kind: DatasetWorkspaceOperationKindSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/), receipt: DatasetWorkspaceReceiptSchema, base: DatasetWorkspaceReceiptSchema.nullable() }).strict().superRefine((value, context) => {
  const { receipt, base, kind } = value;
  if (base && (base.teamId !== receipt.teamId || base.datasetId !== receipt.datasetId || base.revision + 1 !== receipt.revision) || !base && receipt.revision !== 1) context.addIssue({ code: "custom", message: "Operation recovery history identity/revision mismatch." });
  if (base && ((base.ownerScope ?? "workspace") !== (receipt.ownerScope ?? "workspace") || base.originProjectId !== receipt.originProjectId || base.workspace.draft.createdAt !== receipt.workspace.draft.createdAt)) context.addIssue({ code: "custom", message: "Operation recovery cannot change Dataset ownership or origin." });
  const actualKind = !base ? "create" : receipt.workspace.draft.status === "published" ? "publish" : base.workspace.draft.status === "published" ? "begin_version" : "save";
  if (kind !== actualKind) context.addIssue({ code: "custom", message: "Operation recovery kind differs from its retained lifecycle." });
});
export type DatasetWorkspaceOperationResult = z.infer<typeof DatasetWorkspaceOperationResultSchema>;
