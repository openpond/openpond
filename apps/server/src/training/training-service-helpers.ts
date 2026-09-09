import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "@openpond/taskset-sdk";

export { withAuthoritativeRecipeHashes } from "openpond-sdk/training-bundle";

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative);
}

export async function assertArtifactIntegrity(
  artifactPath: string,
  expectedHash: string,
  expectedSize: number,
): Promise<void> {
  const bytes = await readFile(artifactPath);
  if (
    bytes.byteLength !== expectedSize
    || sha256(bytes) !== expectedHash
  ) {
    throw new Error(
      "Model promotion refused an artifact that failed integrity verification.",
    );
  }
}
