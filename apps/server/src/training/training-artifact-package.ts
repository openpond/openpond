import type { ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { TrainingArtifact } from "@openpond/contracts";

const TAR_BLOCK_BYTES = 512;
const PORTABLE_MODEL_FILENAMES = new Set([
  "adapter_model.safetensors",
  "adapter_model.safetensors.index.json",
  "adapter_config.json",
  "stats.json",
  "train_config.json",
]);
const SHARDED_ADAPTER_WEIGHTS_PATTERN =
  /^adapter_model-\d{5}-of-\d{5}\.safetensors$/;

export type PortableModelArtifact = {
  artifact: TrainingArtifact;
  name: string;
  providerFilename: string;
};

export type TrainingArtifactPackage = {
  filename: string;
  manifest: Buffer;
  entries: Array<{
    artifact: TrainingArtifact;
    name: string;
  }>;
};

export function selectPortableModelArtifacts(
  artifacts: TrainingArtifact[],
): PortableModelArtifact[] {
  const selected = new Map<string, PortableModelArtifact>();
  for (const artifact of artifacts) {
    const providerFilename = artifact.metadata.providerFilename;
    if (
      artifact.metadata.provider !== "fireworks"
      || typeof providerFilename !== "string"
    ) {
      continue;
    }
    const normalized = providerFilename.replaceAll("\\", "/");
    const name = path.posix.basename(normalized);
    if (
      !PORTABLE_MODEL_FILENAMES.has(name)
      && !SHARDED_ADAPTER_WEIGHTS_PATTERN.test(name)
    ) continue;
    const candidate = { artifact, name, providerFilename };
    const current = selected.get(name);
    if (!current || shouldPreferArtifact(candidate, current)) {
      selected.set(name, candidate);
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.name.localeCompare(right.name));
}

export function trainingArtifactPackageSize(
  value: TrainingArtifactPackage,
): number {
  return tarEntrySize(value.manifest.byteLength)
    + value.entries.reduce(
      (total, entry) => total + tarEntrySize(entry.artifact.sizeBytes),
      0,
    )
    + TAR_BLOCK_BYTES * 2;
}

export async function streamTrainingArtifactPackage(
  response: ServerResponse,
  value: TrainingArtifactPackage,
): Promise<void> {
  await writeTarEntry(response, {
    name: "openpond-model-manifest.json",
    size: value.manifest.byteLength,
    chunks: [value.manifest],
  });
  for (const entry of value.entries) {
    const info = await stat(entry.artifact.path);
    if (!info.isFile() || info.size !== entry.artifact.sizeBytes) {
      throw new Error(
        `Training artifact ${entry.artifact.id} changed before packaging.`,
      );
    }
    await writeTarEntry(response, {
      name: entry.name,
      size: entry.artifact.sizeBytes,
      chunks: createReadStream(entry.artifact.path),
    });
  }
  await write(response, Buffer.alloc(TAR_BLOCK_BYTES * 2));
  response.end();
}

async function writeTarEntry(
  response: ServerResponse,
  input: {
    name: string;
    size: number;
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  },
): Promise<void> {
  await write(response, tarHeader(input.name, input.size));
  for await (const chunk of input.chunks) {
    await write(response, Buffer.from(chunk));
  }
  const padding = tarPadding(input.size);
  if (padding) await write(response, Buffer.alloc(padding));
}

function tarHeader(nameInput: string, size: number): Buffer {
  const name = nameInput.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!name || Buffer.byteLength(name) > 100) {
    throw new Error(`Training package entry name is invalid: ${nameInput}`);
  }
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "openpond");
  writeString(header, 297, 32, "openpond");
  writeOctal(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return header;
}

function writeString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = Math.max(0, Math.trunc(value))
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  buffer.write(`${octal}\0`, offset, length, "ascii");
}

async function write(
  response: ServerResponse,
  chunk: Buffer,
): Promise<void> {
  if (!response.write(chunk)) await once(response, "drain");
}

function tarEntrySize(size: number): number {
  return TAR_BLOCK_BYTES + size + tarPadding(size);
}

function tarPadding(size: number): number {
  return (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function shouldPreferArtifact(
  candidate: PortableModelArtifact,
  current: PortableModelArtifact,
): boolean {
  const candidateDepth = artifactPathDepth(candidate.providerFilename);
  const currentDepth = artifactPathDepth(current.providerFilename);
  if (candidateDepth !== currentDepth) return candidateDepth < currentDepth;
  if (candidate.artifact.createdAt !== current.artifact.createdAt) {
    return candidate.artifact.createdAt > current.artifact.createdAt;
  }
  return candidate.artifact.id > current.artifact.id;
}

function artifactPathDepth(value: string): number {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).length;
}
