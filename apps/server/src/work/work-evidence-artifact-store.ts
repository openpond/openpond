import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, contentHash, sha256 } from "@openpond/harness";
import { evidenceArtifactRef, type EvidenceArtifactRef } from "@openpond/evals/evidence";

import type { LocalWorkEvidenceArtifact } from "../store/store-work-evidence.js";

type ArtifactKind = LocalWorkEvidenceArtifact["kind"];

export function createWorkEvidenceArtifactStore(storeDir: string) {
  const root = path.join(storeDir, "work", "evidence");

  async function persistPortableJson(input: {
    kind: Exclude<ArtifactKind, "private_trace" | "output_content" | "correction">;
    value: unknown;
    semanticHash?: string;
    mediaType: string;
  }): Promise<LocalWorkEvidenceArtifact> {
    const bytes = Buffer.from(canonicalJson(input.value), "utf8");
    const hash = input.semanticHash ?? contentHash(input.value);
    const target = artifactPath(root, "portable", hash, "json");
    await writeImmutable(target, bytes);
    const ref = evidenceArtifactRef({
      contentHash: hash,
      mediaType: input.mediaType,
      sizeBytes: bytes.byteLength,
    });
    return {
      kind: input.kind,
      visibility: "portable",
      ref,
      contentHash: hash,
      path: target,
      sizeBytes: bytes.byteLength,
    };
  }

  async function persistPrivateJson(input: {
    kind: "private_trace";
    value: unknown;
  }): Promise<LocalWorkEvidenceArtifact> {
    const bytes = Buffer.from(canonicalJson(input.value), "utf8");
    const hash = sha256(bytes);
    const target = artifactPath(root, "private", hash, "json");
    await writeImmutable(target, bytes);
    return {
      kind: input.kind,
      visibility: "private",
      ref: null,
      contentHash: hash,
      path: target,
      sizeBytes: bytes.byteLength,
    };
  }

  async function persistPrivateBytes(input: {
    kind: "correction";
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<LocalWorkEvidenceArtifact> {
    const bytes = Buffer.from(input.bytes);
    const hash = sha256(bytes);
    const target = artifactPath(root, "private", hash, "bin");
    await writeImmutable(target, bytes);
    return {
      kind: input.kind,
      visibility: "private",
      ref: evidenceArtifactRef({
        contentHash: hash,
        mediaType: input.mediaType,
        sizeBytes: bytes.byteLength,
      }),
      contentHash: hash,
      path: target,
      sizeBytes: bytes.byteLength,
    };
  }

  function existingOutputArtifact(input: {
    ref: EvidenceArtifactRef;
    path: string;
  }): LocalWorkEvidenceArtifact {
    return {
      kind: "output_content",
      visibility: "portable",
      ref: input.ref,
      contentHash: input.ref.contentHash,
      path: input.path,
      sizeBytes: input.ref.sizeBytes ?? 0,
    };
  }

  return {
    existingOutputArtifact,
    persistPortableJson,
    persistPrivateBytes,
    persistPrivateJson,
  };
}

function artifactPath(
  root: string,
  visibility: "portable" | "private",
  hash: string,
  extension: "json" | "bin",
): string {
  return path.join(root, visibility, hash.slice(0, 2), `${hash}.${extension}`);
}

async function writeImmutable(target: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (!existing.equals(bytes)) {
      throw new Error(`Immutable Work evidence artifact ${path.basename(target)} changed content.`);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
