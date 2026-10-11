import { z } from "zod";

const ObjectHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Base64 = z.string().max(3_000_000);
const ObjectBytes = z.object({ hash: ObjectHash, base64: Base64 }).strict();
const safePath = (path: string) => !/[\x00-\x1f\x7f]/.test(path) && !path.startsWith("/") && !path.includes("\\")
  && path.split("/").length <= 32 && path.split("/").every(part => part && part !== "." && part !== ".."
    && part !== ".git" && !part.startsWith(".env"));

/** A Git object proof pins bytes to recorded history. It does not establish
 * that the historical working tree was clean or that these are all dependencies. */
export const ConnectedGitFileProofSchema = z.object({
  schemaVersion: z.literal("openpond.connectedGitFileProof.v1"),
  path: z.string().min(1).max(1_000).refine(safePath),
  commit: ObjectBytes,
  trees: z.array(ObjectBytes).min(1).max(32),
  contentsBase64: Base64,
}).strict();
export type ConnectedGitFileProof = z.infer<typeof ConnectedGitFileProofSchema>;
