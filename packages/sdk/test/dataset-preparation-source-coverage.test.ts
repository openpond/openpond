import { expect, it } from "vitest";
import { contentHash } from "@openpond/harness";
import { CollectorCoverageManifestSchema } from "@openpond/evals/connected-evidence";
import { reconcilePreparationSourceCoverage } from "../src/dataset-workspaces.js";

// A stale or fabricated exclusion must never authorize research over an
// unfinished scan, unpaid upload obligation, or partially admitted source.
it("reconciles only exact unreadable source exclusions without claiming complete coverage", () => {
  const now = "2026-10-11T00:00:00.000Z";
  const excluded = { connectionId: "connection", sourceKeyHash: contentHash("unreadable"), nativeRevisionHash: contentHash("original-revision"),
    reason: "source_read_failed" as const, explanation: "Retained original exceeds the supported read bound." };
  const source = { projectId: "project", connections: ["connection"], from: "2026-10-04T00:00:00.000Z", to: now, importCutoff: now, excludedSessions: [excluded] };
  const manifest = CollectorCoverageManifestSchema.parse({ schemaVersion: "openpond.collectorCoverageManifest.v1", jobId: "job", connectionId: "connection",
    connectionRevision: 1, machineId: "machine", sourceInstanceId: "instance", from: source.from, to: now, startedAt: now, finishedAt: now,
    listingComplete: true, pendingOperations: 0, sessions: [{ sourceKeyHash: excluded.sourceKeyHash, nativeRevisionHash: excluded.nativeRevisionHash,
      state: "failed", reason: excluded.reason, unknownTimeBoundaries: 0, normalized: [] }] });
  const result = reconcilePreparationSourceCoverage({ manifest, source });
  expect(result).toMatchObject({ reconciled: true, sourceComplete: false, excludedSessions: 1 });
  expect(result.summary).toMatchObject({ complete: false, failedSessions: 1, eligibleTurns: 0 });
  expect(reconcilePreparationSourceCoverage({ manifest, source: { ...source, excludedSessions: [] } }).reconciled).toBe(false);
  expect(reconcilePreparationSourceCoverage({ manifest: { ...manifest, listingComplete: false }, source }).reconciled).toBe(false);
  expect(reconcilePreparationSourceCoverage({ manifest: { ...manifest, pendingOperations: 1 }, source }).reconciled).toBe(false);
  expect(() => reconcilePreparationSourceCoverage({ manifest, source: { ...source, excludedSessions: [{ ...excluded, nativeRevisionHash: contentHash("changed") }] } })).toThrow(/exclusion_changed/);
  expect(() => reconcilePreparationSourceCoverage({ manifest, source: { ...source, excludedSessions: [{ ...excluded, connectionId: "foreign" }] } })).toThrow(/selected source connections/);
  const partiallyAdmitted = { ...manifest, sessions: [{ ...manifest.sessions[0]!, normalized: [{ sessionHash: contentHash("session"), boundaries: [{
    id: "boundary", inputHash: contentHash("input"), revisionHash: contentHash("revision"), occurredAt: source.from }] }] }] };
  expect(() => reconcilePreparationSourceCoverage({ manifest: partiallyAdmitted, source })).toThrow(/exclusion_changed/);
});
