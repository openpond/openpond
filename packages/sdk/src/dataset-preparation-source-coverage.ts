import {
  CollectorCoverageManifestSchema,
  summarizeCollectorCoverage,
  type CollectorCoverageManifest,
} from "@openpond/evals/connected-evidence";
import { DatasetPreparationSourceSchema } from "./dataset-preparation-contracts.js";

/** An exclusion accounts for one explicitly named unreadable original source.
 * It never admits that source, forgives queued uploads or changes the eligible
 * boundary inventory used for hosted membership reconciliation. */
export function reconcilePreparationSourceCoverage(input: {
  manifest: CollectorCoverageManifest;
  source: unknown;
}) {
  const source = DatasetPreparationSourceSchema.parse(input.source);
  const manifest = CollectorCoverageManifestSchema.parse(input.manifest);
  const summary = summarizeCollectorCoverage(manifest);
  const exclusions = source.excludedSessions.filter(item => item.connectionId === manifest.connectionId);
  const retained = new Map(manifest.sessions.map(session => [session.sourceKeyHash, session]));
  const excluded = new Set<string>();
  for (const selection of exclusions) {
    const session = retained.get(selection.sourceKeyHash);
    if (!session || session.nativeRevisionHash !== selection.nativeRevisionHash || session.reason !== selection.reason
      || !(session.state === "failed" && selection.reason === "source_read_failed"
        || session.state === "skipped" && selection.reason === "native_session_not_ready")
      || session.unknownTimeBoundaries !== 0 || session.normalized.some(item => item.boundaries.length > 0))
      throw new Error("dataset_preparation_source_exclusion_changed");
    excluded.add(selection.sourceKeyHash);
  }
  const reconciled = source.connections.includes(manifest.connectionId)
    && manifest.from === source.from && manifest.to === source.to
    && manifest.finishedAt !== null && manifest.listingComplete && manifest.pendingOperations === 0
    && summary.unknownTimeBoundaries === 0
    && manifest.sessions.every(session => session.nativeRevisionHash !== null
      && (session.state === "admitted"
        || session.state === "skipped" && session.reason === "no_eligible_boundaries"
        || excluded.has(session.sourceKeyHash)));
  return { reconciled, sourceComplete: summary.complete, excludedSessions: excluded.size, summary };
}
