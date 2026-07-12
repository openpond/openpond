import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TrainingBundleExportSchema, type TrainingBundleExport } from "@openpond/contracts";
import { canonicalJson, contentHash, sha256 } from "@openpond/taskset-sdk";
import { inspectTrainingBundle, validateTrainingBundle } from "./bundle.js";

export async function createTrainingBundleExport(directory: string): Promise<TrainingBundleExport> {
  const validation = await validateTrainingBundle(directory);
  if (!validation.valid) throw new Error(`Training Bundle is invalid: ${validation.issues.join("; ")}`);
  const manifest = await inspectTrainingBundle(directory);
  const files = [];
  for (const item of manifest.files) {
    const relative = safeRelativePath(item.path);
    const bytes = await readFile(path.join(directory, relative));
    files.push({ path: relative, sha256: sha256(bytes), sizeBytes: bytes.byteLength, encoding: "base64" as const, content: bytes.toString("base64") });
  }
  const base = { schemaVersion: "openpond.trainingBundleExport.v1" as const, manifest, files, contentHash: "00000000" };
  return TrainingBundleExportSchema.parse({ ...base, contentHash: contentHash({ ...base, contentHash: "" }) });
}

export async function unpackTrainingBundleExport(input: unknown, directory: string): Promise<TrainingBundleExport> {
  const bundle = TrainingBundleExportSchema.parse(input);
  if (contentHash({ ...bundle, contentHash: "" }) !== bundle.contentHash) throw new Error("Training Bundle export content hash mismatch.");
  for (const item of bundle.files) {
    const relative = safeRelativePath(item.path);
    const bytes = Buffer.from(item.content, "base64");
    if (bytes.byteLength !== item.sizeBytes || sha256(bytes) !== item.sha256) throw new Error(`Training Bundle export file failed verification: ${relative}.`);
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const validation = await validateTrainingBundle(directory);
  if (!validation.valid) throw new Error(`Unpacked Training Bundle is invalid: ${validation.issues.join("; ")}`);
  return bundle;
}

export async function writeTrainingBundleExport(directory: string, outputFile: string): Promise<TrainingBundleExport> {
  const bundle = await createTrainingBundleExport(directory);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, canonicalJson(bundle), "utf8");
  return bundle;
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe Training Bundle path: ${value}.`);
  return normalized;
}
