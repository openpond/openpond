import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { ConnectedRepositoryContextSchema } from "../connected-evidence/contracts.js";
import { ConnectedGitFileProofSchema, verifyConnectedGitFileProof } from "../connected-evidence/git-file-proof.js";

const execute = promisify(execFile);

/** Capture only recorded Git objects. A missing historical object is an explicit
 * gap; this operation never reads the current worktree or fetches another repo. */
export async function captureNativeGitAssetProofs(input: {
  repositoryPath: string;
  repositoryContext: unknown;
  paths: string[];
  signal?: AbortSignal;
}) {
  const context = ConnectedRepositoryContextSchema.parse(input.repositoryContext);
  if (!isAbsolute(input.repositoryPath) || !input.paths.length || input.paths.length > 100
    || new Set(input.paths).size !== input.paths.length) throw new Error("native_git_asset_selection_invalid");
  // Validate selections before invoking Git, including paths prohibited by the
  // source asset policy. The remaining fields are filled from immutable objects.
  for (const path of input.paths) ConnectedGitFileProofSchema.shape.path.parse(path);
  const repository = await realpath(input.repositoryPath);
  const read = async (args: string[], maxBuffer = 2 * 1024 * 1024) => {
    input.signal?.throwIfAborted();
    const result = await execute("git", ["-C", repository, ...args], {
      encoding: "buffer", timeout: 15_000, maxBuffer, signal: input.signal,
    });
    return result.stdout;
  };
  const objectId = async (ref: string) => {
    const hash = (await read(["rev-parse", "--verify", ref], 1_024)).toString("ascii").trim();
    if (!new RegExp(`^[a-f0-9]{${context.commitHash.length}}$`).test(hash)) throw new Error("native_git_object_identity_invalid");
    return hash;
  };
  const commit = await read(["cat-file", "commit", context.commitHash], 256 * 1024);
  const cache = new Map<string, { hash: string; base64: string }>();
  let totalBytes = 0;
  const proofs = [];
  for (const path of input.paths) {
    const directories = ["", ...path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))];
    const trees = [];
    for (const directory of directories) {
      const ref = directory ? `${context.commitHash}:${directory}` : `${context.commitHash}^{tree}`;
      let tree = cache.get(ref);
      if (!tree) {
        const hash = await objectId(ref);
        tree = { hash, base64: (await read(["cat-file", "tree", hash])).toString("base64") };
        cache.set(ref, tree);
      }
      trees.push(tree);
    }
    const blob = await objectId(`${context.commitHash}:${path}`);
    const proof = ConnectedGitFileProofSchema.parse({ schemaVersion: "openpond.connectedGitFileProof.v1", path,
      commit: { hash: context.commitHash, base64: commit.toString("base64") }, trees,
      contentsBase64: (await read(["cat-file", "blob", blob])).toString("base64") });
    const verified = verifyConnectedGitFileProof(context, proof);
    totalBytes += Buffer.byteLength(JSON.stringify(proof));
    if (totalBytes > 16 * 1024 * 1024) throw new Error("native_git_asset_capture_limit");
    proofs.push({ proof, verified });
  }
  return proofs;
}
