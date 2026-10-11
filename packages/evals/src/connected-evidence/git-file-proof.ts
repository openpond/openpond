import { createHash } from "node:crypto";
import { ConnectedGitFileProofSchema } from "./git-file-contracts.js";
export * from "./git-file-contracts.js";
import { ConnectedRepositoryContextSchema } from "./contracts.js";


function bytes(base64: string, limit: number) {
  const value = Buffer.from(base64, "base64");
  if (value.toString("base64") !== base64 || value.byteLength > limit)
    throw new Error("connected_git_object_bytes_invalid");
  return value;
}

function objectHash(kind: "commit" | "tree" | "blob", value: Buffer, width: number) {
  return createHash(width === 40 ? "sha1" : "sha256")
    .update(`${kind} ${value.byteLength}\0`).update(value).digest("hex");
}

function treeEntry(tree: Buffer, name: string, width: number) {
  let offset = 0;
  const names = new Set<string>();
  let found: { mode: string; hash: string } | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset < tree.byteLength) {
    const space = tree.indexOf(32, offset), nul = tree.indexOf(0, space + 1);
    const end = nul + 1 + width / 2;
    if (space < offset || nul < space || end > tree.byteLength) throw new Error("connected_git_tree_invalid");
    const mode = tree.subarray(offset, space).toString("ascii");
    const entryName = decoder.decode(tree.subarray(space + 1, nul));
    if (!entryName || entryName.includes("/") || names.has(entryName)) throw new Error("connected_git_tree_invalid");
    names.add(entryName);
    if (entryName === name) found = { mode, hash: tree.subarray(nul + 1, end).toString("hex") };
    offset = end;
  }
  if (!found) throw new Error("connected_git_path_missing");
  return found;
}

/** The caller must supply repositoryContext from an authorized, hash-verified
 * connected snapshot. No filesystem access or caller-selected Git command occurs. */
export function verifyConnectedGitFileProof(repositoryContext: unknown, raw: unknown) {
  const context = ConnectedRepositoryContextSchema.parse(repositoryContext);
  const proof = ConnectedGitFileProofSchema.parse(raw);
  const width = context.commitHash.length;
  const commit = bytes(proof.commit.base64, 256 * 1024);
  if (proof.commit.hash !== context.commitHash || objectHash("commit", commit, width) !== context.commitHash)
    throw new Error("connected_git_commit_mismatch");
  const firstNewline = commit.indexOf(10);
  if (firstNewline < 0) throw new Error("connected_git_commit_invalid");
  const firstLine = commit.subarray(0, firstNewline).toString("ascii");
  if (!new RegExp(`^tree [a-f0-9]{${width}}$`).test(firstLine)) throw new Error("connected_git_commit_invalid");
  const trees = new Map<string, Buffer>();
  let totalBytes = commit.byteLength;
  for (const object of proof.trees) {
    const value = bytes(object.base64, 2 * 1024 * 1024);
    totalBytes += value.byteLength;
    if (totalBytes > 8 * 1024 * 1024 || trees.has(object.hash) || object.hash.length !== width
      || objectHash("tree", value, width) !== object.hash) throw new Error("connected_git_tree_mismatch");
    trees.set(object.hash, value);
  }
  const parts = proof.path.split("/");
  const visited = new Set<string>();
  let hash = firstLine.slice(5);
  let mode = "";
  for (const [index, part] of parts.entries()) {
    const tree = trees.get(hash);
    if (!tree || visited.has(hash)) throw new Error("connected_git_tree_missing");
    visited.add(hash);
    const entry = treeEntry(tree, part, width);
    mode = entry.mode;
    if (index < parts.length - 1 ? mode !== "40000" : !["100644", "100755"].includes(mode))
      throw new Error("connected_git_file_mode_invalid");
    hash = entry.hash;
  }
  if (visited.size !== trees.size) throw new Error("connected_git_unreferenced_tree");
  const content = bytes(proof.contentsBase64, 2 * 1024 * 1024);
  if (objectHash("blob", content, width) !== hash) throw new Error("connected_git_blob_mismatch");
  return { path: proof.path, commitHash: context.commitHash, gitObjectHash: hash, mode,
    sizeBytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"),
    contentsBase64: content.toString("base64") };
}
