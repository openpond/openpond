import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ConnectedCaseRefSchema } from "./connected-evidence-contracts.js";
import { ConnectedStartingAssetSchema } from "./connected-starting-assets.js";
import { TasksetEnvironmentContractSchema } from "./taskset-draft-core.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export function connectedStartingAssetReference(receiptId: string, path: string) {
  if (!/^starting-assets-[a-f0-9]{40}$/.test(receiptId)) throw new Error("Invalid starting asset receipt.");
  ConnectedStartingAssetSchema.shape.path.parse(path);
  return `starting-assets:${receiptId}#${encodeURIComponent(path)}`;
}
export function parseConnectedStartingAssetReference(reference: string) {
  const match = /^starting-assets:(starting-assets-[a-f0-9]{40})#(.+)$/.exec(reference);
  if (!match) throw new Error("Invalid starting asset reference.");
  const path = decodeURIComponent(match[2]!);
  if (connectedStartingAssetReference(match[1]!, path) !== reference) throw new Error("Noncanonical starting asset reference.");
  return { receiptId: match[1]!, path };
}

/** A host-owned selection of immutable bytes. Dependency sufficiency and
 * executable outcome checks still require isolated qualification. */
export const PreparedRepositoryStartingStateSchema = z.object({
  schemaVersion: z.literal("openpond.preparedRepositoryStartingState.v1"),
  dependencyClosureQualified: z.literal(false),
  assets: z.array(ConnectedStartingAssetSchema.extend({
    receiptId: z.string().regex(/^starting-assets-[a-f0-9]{40}$/), receiptHash: Hash,
    source: ConnectedCaseRefSchema,
  }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.assets.map(asset => asset.path)).size !== value.assets.length)
    ctx.addIssue({ code: "custom", message: "Starting paths must be distinct." });
  if (value.assets.some(asset => asset.commitHash !== value.assets[0]!.commitHash
    || contentHash(asset.source) !== contentHash(value.assets[0]!.source)))
    ctx.addIssue({ code: "custom", message: "Starting assets must belong to one original task boundary and commit." });
});
export type PreparedRepositoryStartingState = z.infer<typeof PreparedRepositoryStartingStateSchema>;

export function preparedRepositoryEnvironment() {
  return TasksetEnvironmentContractSchema.parse({ protocolVersion: "openpond.taskEnvironment.v1", kind: "work",
    entrypoint: "openpond-work-v1", stateful: true, deterministicSeeds: true,
    toolNames: ["work_exec", "work_save_output"], lifecycle: ["create", "reset", "step", "grade", "cleanup"],
    defaultTimeoutMs: 300_000, networkPolicy: "none",
    resources: [],
    metadata: { requiredOutputs: [{ path: "changes.patch", mediaType: "text/x-diff", maxBytes: 5_000_000,
        metadata: { protocol: "openpond.preparedRepositoryPatch.v1", baseDirectory: "starting-state",
          description: "Save a unified diff against the retained starting files, with original repository-relative paths." } }],
      maxInputBytes: 15 * 1024 * 1024 },
  });
}
