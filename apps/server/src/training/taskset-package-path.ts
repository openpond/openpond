import path from "node:path";
import type { Taskset } from "@openpond/contracts";

/** Local file identity is independent of a Taskset's logical revision identity. */
export function tasksetPackageDirectoryId(taskset: Taskset): string {
  const declared = taskset.environment.metadata.runtimeSourceTasksetId;
  const id = declared === undefined ? taskset.id : declared;
  if (typeof id !== "string" || !id || id === "." || id === ".." || path.basename(id) !== id || id.includes("\\")) {
    throw new Error(`Taskset ${taskset.id} has an invalid package directory identity.`);
  }
  return id;
}
