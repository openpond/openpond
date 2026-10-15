import { TasksetSchema } from "@openpond/contracts";
import { canonicalJson } from "@openpond/harness";
import { z } from "zod";
import { TasksetPackageSchema, prepareImportedTasksetPackage } from "openpond-sdk/taskset-packages";

export const ModelProjectPullSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.modelProjectPullSnapshot.v1"),
  package: TasksetPackageSchema,
  taskset: TasksetSchema,
}).strict();

/** Explicit recovery for an authenticated Model that pins a projected local
 * Taskset. The supplied bytes are evidence, never authority to change its pin. */
export function prepareModelProjectPullSnapshot(
  snapshot: z.infer<typeof ModelProjectPullSnapshotSchema>,
  selected: { id: string; revision: number; contentHash: string },
  profileId: string,
) {
  const saved = snapshot.taskset;
  if (saved.profileId !== profileId) {
    throw new Error(`Snapshot belongs to local Profile ${saved.profileId}. Use that exact Profile to preserve its Taskset hash. Local work was retained.`);
  }
  if (saved.id !== selected.id || saved.revision !== selected.revision || saved.contentHash !== selected.contentHash) {
    throw new Error("Snapshot does not match the authenticated Model's exact Taskset reference. Local work was retained.");
  }
  const prepared = prepareImportedTasksetPackage({ package: snapshot.package,
    profileId, name: saved.name, createdAt: saved.createdAt });
  if (canonicalJson(prepared.taskset) !== canonicalJson(saved)) {
    throw new Error("Snapshot projection differs from its verified immutable package. Local work was retained.");
  }
  return prepared;
}
