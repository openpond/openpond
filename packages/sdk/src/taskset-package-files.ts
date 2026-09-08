import { z } from "zod";
import { ImmutableAssetRefSchema, sha256 } from "@openpond/harness";

/** The limit covers the entire decoded JSON envelope, including base64. */
export const MAX_TASKSET_PACKAGE_BYTES = 64 * 1024 * 1024;
export const TasksetPackageFileSchema = z.object({
  asset: ImmutableAssetRefSchema,
  base64: z.string().max(Math.ceil(MAX_TASKSET_PACKAGE_BYTES / 3) * 4),
}).strict();
export type TasksetPackageFile = z.infer<typeof TasksetPackageFileSchema>;

export function decodeTasksetPackageFile(value: TasksetPackageFile): Uint8Array {
  const file = TasksetPackageFileSchema.parse(value);
  const raw = atob(file.base64);
  if (btoa(raw) !== file.base64) throw new Error(`Taskset asset ${file.asset.id} has noncanonical base64.`);
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  if (bytes.byteLength !== file.asset.sizeBytes || sha256(bytes) !== file.asset.contentHash) throw new Error(`Taskset asset ${file.asset.id} differs from its immutable bytes.`);
  return bytes;
}
