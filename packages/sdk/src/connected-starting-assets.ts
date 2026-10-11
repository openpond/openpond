import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ConnectedGitFileProofSchema } from "@openpond/evals/connected-evidence";
import { ConnectedCaseRefSchema } from "./connected-evidence-contracts.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ConnectedStartingAssetsRequestSchema = z.object({
  operationId: Id, source: ConnectedCaseRefSchema,
  proofs: z.array(ConnectedGitFileProofSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.proofs.map(proof => proof.path)).size !== value.proofs.length)
    ctx.addIssue({ code: "custom", message: "Select each starting path once." });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 15 * 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "Starting assets exceed the retained upload allowance." });
});
export const ConnectedStartingAssetSchema = z.object({
  path: ConnectedGitFileProofSchema.shape.path, commitHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  gitObjectHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  mode: z.enum(["100644", "100755"]), sizeBytes: z.number().int().nonnegative().max(2 * 1024 * 1024), sha256: Hash,
}).strict();
export const ConnectedStartingAssetsReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.connectedStartingAssetsReceipt.v1"),
  id: Id, operationId: Id, teamId: Id, ownerUserId: Id, projectId: Id,
  requestHash: Hash, source: ConnectedCaseRefSchema, inputHash: Hash, observationHash: Hash,
  assets: z.array(ConnectedStartingAssetSchema).min(1).max(100),
  selectedPathsUnmodified: z.literal(true), dependencyClosureQualified: z.literal(false),
  createdAt: z.iso.datetime(), receiptHash: Hash,
}).strict();
export type ConnectedStartingAssetsRequest = z.infer<typeof ConnectedStartingAssetsRequestSchema>;
export type ConnectedStartingAssetsReceipt = z.infer<typeof ConnectedStartingAssetsReceiptSchema>;
export function verifyConnectedStartingAssetsReceipt(raw: unknown) {
  const value = ConnectedStartingAssetsReceiptSchema.parse(raw);
  const { receiptHash, ...body } = value;
  if (contentHash(body) !== receiptHash || value.id !== `starting-assets-${contentHash(value.operationId).slice(0, 40)}`
    || new Set(value.assets.map(asset => asset.path)).size !== value.assets.length
    || value.assets.some(asset => asset.commitHash !== value.assets[0]!.commitHash))
    throw new Error("Connected starting assets receipt identity differs from its retained evidence.");
  return value;
}
