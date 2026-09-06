import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256, type ImmutableAssetRef } from "@openpond/harness";

/** Only released files enter the execution directory, verified on every reuse. */
export async function materializeHarnessSource(input: {
  sourcePath: string;
  storeDir: string;
  harnessHash: string;
  files: ImmutableAssetRef[];
}): Promise<void> {
  const root = path.join(input.storeDir, "training", "harnesses", input.harnessHash, "source");
  let exists = false;
  try { await access(root); exists = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    await verifyFiles(root, input.files);
    return;
  }
  await mkdir(path.dirname(root), { recursive: true });
  const temporary = `${root}.materializing-${randomUUID()}`;
  await mkdir(temporary);
  try {
    const sourceRoot = await realpath(input.sourcePath);
    for (const file of input.files) {
      const bytes = await readVerifiedFile(sourceRoot, file);
      const target = containedPath(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    try { await rename(temporary, root); } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    await verifyFiles(root, input.files);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function verifyFiles(root: string, files: ImmutableAssetRef[]) {
  const resolved = await realpath(root);
  for (const file of files) await readVerifiedFile(resolved, file);
}

async function readVerifiedFile(root: string, file: ImmutableAssetRef) {
  const candidate = containedPath(root, file.path);
  const resolved = await realpath(candidate);
  assertContained(root, resolved);
  const bytes = await readFile(resolved);
  if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== file.contentHash) {
    throw new Error(`Released Harness file ${file.path} does not match its immutable bytes.`);
  }
  return bytes;
}

function containedPath(root: string, relative: string) {
  const candidate = path.resolve(root, ...relative.split("/"));
  assertContained(root, candidate);
  return candidate;
}

function assertContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Released Harness file escapes its execution directory.");
  }
}
