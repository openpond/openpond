import { lstatSync } from "node:fs";
import path from "node:path";
import { PersistenceError, isMissing } from "./errors.js";

/** Check existing ancestors before creating or opening managed storage. */
export function assertStorageAncestors(file: string): void {
  let directory = path.resolve(file);
  while (true) {
    try {
      const stat = lstatSync(directory);
      // macOS publishes these system roots as aliases into /private.
      const systemAlias = process.platform === "darwin" && ["/tmp", "/var", "/etc"].includes(directory);
      if (stat.isSymbolicLink() && !systemAlias) throw new PersistenceError({ code: "UNSAFE_STORAGE_PATH", path: directory, message: "A managed storage path passes through a symbolic link.", action: "Use the canonical local folder and keep managed subdirectories inside that home." });
    } catch (error) { if (!isMissing(error)) throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
