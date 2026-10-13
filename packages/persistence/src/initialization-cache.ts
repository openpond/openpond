import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertStorageAncestors } from "./path-safety.js";
import { isMissing } from "./errors.js";
import { storagePaths } from "./home.js";
import type { MigrationReport } from "./migration.js";

const verifiedHomes = new Map<string, { signature: string; report: MigrationReport }>();

/** Only completed layout checks are reusable; replacement or edits invalidate them. */
export async function initializationSignature(home: string): Promise<string | null> {
  const paths = storagePaths(home);
  assertStorageAncestors(paths.runtime);
  const parts = await Promise.all(
    [paths.marker, path.join(paths.runtime, "migration.json")].map(async (file) => {
      try {
        const stat = await lstat(file, { bigint: true });
        if (!stat.isFile()) return null;
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch (error) {
        if (isMissing(error)) return "missing";
        throw error;
      }
    }),
  );
  return parts.some((part) => part === null) || parts[0] === "missing" ? null : parts.join("/");
}

export function cachedInitialization(
  home: string,
  signature: string | null,
): MigrationReport | null {
  const cached = verifiedHomes.get(home);
  if (!signature || cached?.signature !== signature) {
    verifiedHomes.delete(home);
    return null;
  }
  return { ...cached.report };
}

export function rememberInitialization(
  home: string,
  signature: string,
  report: MigrationReport,
): void {
  verifiedHomes.delete(home);
  verifiedHomes.set(home, { signature, report: { ...report } });
  if (verifiedHomes.size > 16) verifiedHomes.delete(verifiedHomes.keys().next().value!);
}
