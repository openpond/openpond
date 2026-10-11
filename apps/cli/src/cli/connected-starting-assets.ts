import { stat, readFile } from "node:fs/promises";
import { z } from "zod";
import { previewAgentImport, CONNECTED_EVIDENCE_LIMITS } from "@openpond/evals/connected-evidence";
import { verifyConnectedGitStartingAssets } from "@openpond/evals/connected-evidence/git";
import { captureNativeGitAssetProofs } from "@openpond/evals/native-conversations";
import { ConnectedCaseRefSchema, ConnectedStartingAssetsRequestSchema, type ConnectedEvidenceClient } from "openpond-sdk/connected-evidence";
import { readEvaluationCommandInput } from "./evaluation-command-access";

/** Capture the immutable object closure through the public source API. The cloud
 * owner independently checks the retained snapshot and recorded status before
 * retaining any starting bytes; local execution never creates a qualification. */
export async function captureConnectedStartingAssets(options: Record<string, string | boolean>, client: ConnectedEvidenceClient, signal: AbortSignal) {
  const input = z.object({ operationId: ConnectedStartingAssetsRequestSchema.shape.operationId,
    source: ConnectedCaseRefSchema, sourceFile: z.string().min(1).max(2_000), sourcePath: z.string().min(1).max(500), repositoryPath: z.string().min(1).max(2_000),
    paths: z.array(z.string().min(1).max(1_000)).min(1).max(100),
    acquisition: z.object({ machineId: z.string().min(1).max(500), sourceInstanceId: z.string().min(1).max(500) }).strict().optional(),
  }).strict().parse(await readEvaluationCommandInput(options));
  const info = await stat(input.sourceFile);
  if (!info.isFile() || info.size > CONNECTED_EVIDENCE_LIMITS.sourceBytes) throw new Error("Selected source exceeds the retained source byte allowance.");
  signal.throwIfAborted();
  const bytes = await readFile(input.sourceFile, { signal });
  if (bytes.byteLength > CONNECTED_EVIDENCE_LIMITS.sourceBytes) throw new Error("Selected source grew beyond the retained byte allowance.");
  const preview = previewAgentImport({ source: "codex", acquisition: input.acquisition,
    files: [{ path: input.sourcePath, text: new TextDecoder("utf8", { fatal: true }).decode(bytes) }] });
  if (preview.issues.length || preview.sessions.length !== 1) throw new Error("Selected source cannot be normalized without gaps.");
  const session = preview.sessions[0]!;
  if (session.contentHash !== input.source.snapshotHash) throw new Error("Selected native bytes or acquisition differ from the retained source snapshot.");
  const proofs = (await captureNativeGitAssetProofs({ repositoryPath: input.repositoryPath,
    repositoryContext: session.repositoryContext, paths: input.paths, signal })).map(asset => asset.proof);
  const verified = verifyConnectedGitStartingAssets({ session, boundaryId: input.source.boundaryId, proofs });
  if (verified.revisionHash !== input.source.boundaryRevisionHash) throw new Error("Selected source boundary revision differs from the retained case.");
  return client.retainStartingAssets({ operationId: input.operationId, source: input.source, proofs }, signal);
}
