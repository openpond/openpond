import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  PonderDesktopSourceSchema,
  type Session,
  type PonderDesktopSource,
} from "@openpond/contracts";
import { createWorkEvidenceArtifactStore } from "../work/work-evidence-artifact-store.js";
import { runWorkspaceCommand } from "../workspace/workspace-command.js";
import {
  isGeneratedWorkspacePath,
  normalizeWorkspaceFilePath,
} from "../workspace/workspace-common.js";

const fileSchema = z
  .object({
    path: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    mode: z.number().int(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(2),
    repositoryPath: z.string().min(1),
    workspaceId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    baseCommit: z.string(),
    files: z.array(fileSchema).max(20_000),
    diff: z.string(),
    changedFiles: z.array(z.string()).max(20_000),
  })
  .strict();
const MAX_BYTES = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeSourcePath = (file: string) =>
  normalizeWorkspaceFilePath(file) === file &&
  !isGeneratedWorkspacePath(file) &&
  !file.split("/").some((part) => part === ".env" || part.startsWith(".env."));

/** Retain the diff and changed bytes; unchanged context comes from the exact Git base. */
export function createPonderDesktopSourceStore(storeDir: string) {
  const artifacts = createWorkEvidenceArtifactStore(storeDir);
  async function git(cwd: string, args: string[]) {
    const result = await runWorkspaceCommand("git", args, cwd);
    if (result.code !== 0)
      throw new Error("The workflow source requires an available Git workspace.");
    return result.stdout;
  }
  async function list(cwd: string) {
    const files = [
      ...new Set(
        (
          await git(cwd, ["diff", "--name-only", "--no-ext-diff", "-z", "HEAD", "--", "."])
          + await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."])
        )
          .split("\0")
          .filter(Boolean),
      ),
    ]
      .filter(safeSourcePath)
      .sort();
    if (files.length > 20_000)
      throw new Error("The workflow source exceeds the 20,000-file limit.");
    return files;
  }
  async function capture(session: Session, turnId: string): Promise<PonderDesktopSource> {
    if (!session.cwd) throw new Error("The workflow has no local source directory.");
    const cwd = await realpath(session.cwd);
    const baseCommit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    const paths = await list(cwd);
    const files: z.infer<typeof fileSchema>[] = [];
    const observations: Array<{ file: string; size: number; mtime: number; mode: number }> = [];
    let total = 0;
    for (const file of paths) {
      const absolute = path.join(cwd, file);
      const before = await lstat(absolute).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!before) continue; // Deletions stay in changedFiles and must not fall back to Git.
      if (!before.isFile())
        throw new Error(`Workflow source cannot snapshot a symlink or submodule: ${file}`);
      const resolved = await realpath(absolute);
      if (!resolved.startsWith(`${cwd}${path.sep}`))
        throw new Error("Workflow source escaped its project directory.");
      total += before.size;
      if (total > MAX_BYTES) throw new Error("The workflow's changed files exceed the 64 MiB review limit.");
      const bytes = await readFile(absolute);
      const after = await lstat(absolute);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.mode !== after.mode
      )
        throw new Error(
          "The workflow source changed during capture. Finish edits before handing it off.",
        );
      files.push({
        path: file,
        hash: await artifacts.persistPortableBytes(bytes),
        size: bytes.length,
        mode: before.mode & 0o777,
      });
      observations.push({ file, size: after.size, mtime: after.mtimeMs, mode: after.mode });
    }
    const changedFiles = paths;
    const diff = changedFiles.length
      ? await git(cwd, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...changedFiles])
      : "";
    if (Buffer.byteLength(diff) > 8 * 1024 * 1024)
      throw new Error("The workflow diff exceeds the retained evidence limit.");
    for (const entry of observations) {
      const now = await lstat(path.join(cwd, entry.file));
      if (
        !now.isFile() ||
        now.size !== entry.size ||
        now.mtimeMs !== entry.mtime ||
        now.mode !== entry.mode
      )
        throw new Error("The workflow source changed before its snapshot committed.");
    }
    if (
      JSON.stringify(paths) !== JSON.stringify(await list(cwd)) ||
      baseCommit !== (await git(cwd, ["rev-parse", "HEAD"])).trim()
    )
      throw new Error("The workflow source revision changed during capture.");
    const workspaceId = session.localProjectId ?? session.workspaceId ?? session.cwd;
    const manifest = manifestSchema.parse({
      version: 2,
      repositoryPath: cwd,
      workspaceId,
      sessionId: session.id,
      turnId,
      baseCommit,
      files,
      diff,
      changedFiles,
    });
    const artifact = await artifacts.persistPortableJson({
      kind: "output_revision",
      value: manifest,
      mediaType: "application/vnd.openpond.source-snapshot+json",
    });
    return PonderDesktopSourceSchema.parse({
      manifestHash: artifact.contentHash,
      workspaceId,
      sessionId: session.id,
      turnId,
      baseCommit,
      fileCount: files.length,
    });
  }
  async function read(source: PonderDesktopSource) {
    source = PonderDesktopSourceSchema.parse(source);
    const manifest = manifestSchema.parse(await artifacts.readPortableJson(source.manifestHash));
    if (
      manifest.workspaceId !== source.workspaceId ||
      manifest.sessionId !== source.sessionId ||
      manifest.turnId !== source.turnId ||
      manifest.baseCommit !== source.baseCommit ||
      manifest.files.length !== source.fileCount
    )
      throw new Error("The workflow source identity changed.");
    return manifest;
  }
  return {
    capture,
    verify: async (source: PonderDesktopSource) => {
      await read(source);
    },
    async inspect(source: PonderDesktopSource, file: string | undefined, offset = 0) {
      const manifest = await read(source);
      if (!file)
        return {
          source,
          changedFiles: manifest.changedFiles.slice(0, 200),
          changedFilesTruncated: manifest.changedFiles.length > 200,
          files: manifest.files
            .slice(offset, offset + 200)
            .map(({ path, hash, size }) => ({ path, hash, size })),
          nextFileOffset: offset + 200 < manifest.files.length ? offset + 200 : null,
          diff: manifest.diff.slice(offset, offset + 32_000),
          nextOffset: offset + 32_000 < manifest.diff.length ? offset + 32_000 : null,
          note: "The diff and changed files are retained. Unchanged context is read from the exact Git base commit by path, never from the current checkout. Deleted files are unavailable.",
        };
      if (!safeSourcePath(file)) throw new Error("Invalid workflow source path.");
      const entry = manifest.files.find((entry) => entry.path === file);
      if (!entry) {
        if (manifest.changedFiles.includes(file)) throw new Error("This file was deleted in the reviewed change.");
        const tree = await git(manifest.repositoryPath, ["ls-tree", "-z", manifest.baseCommit, "--", file]);
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
        if (!match || match[3] !== file) throw new Error("This file is not regular source in the review's Git base.");
        const objectId = match[2]!;
        const size = Number((await git(manifest.repositoryPath, ["cat-file", "-s", objectId])).trim());
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES)
          throw new Error("The requested Git context exceeds the review limit.");
        const text = await git(manifest.repositoryPath, ["cat-file", "blob", objectId]);
        const bytes = Buffer.from(text);
        const objectHash = createHash(objectId.length === 40 ? "sha1" : "sha256")
          .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (bytes.length !== size || objectHash !== objectId || text.includes("\0"))
          throw new Error("This Git source is binary or its bytes could not be verified.");
        return { source, path: file, hash: hash(bytes), text: text.slice(offset, offset + 32_000),
          nextOffset: offset + 32_000 < text.length ? offset + 32_000 : null };
      }
      const bytes = await artifacts.readPortableBytes(entry.hash);
      if (bytes.length !== entry.size || hash(bytes) !== entry.hash)
        throw new Error("Workflow source file changed.");
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes))
        throw new Error("This source file is binary; use its retained hash for identity.");
      return {
        source,
        path: file,
        hash: entry.hash,
        text: text.slice(offset, offset + 32_000),
        nextOffset: offset + 32_000 < text.length ? offset + 32_000 : null,
      };
    },
  };
}
