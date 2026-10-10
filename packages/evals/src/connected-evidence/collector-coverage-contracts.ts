import { z } from "zod";
import { contentHash } from "@openpond/harness";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime();
const Count = z.number().int().nonnegative().max(1_000_000);

export const CollectorCoverageSessionSchema = z
  .object({
    sourceKeyHash: Hash,
    nativeRevisionHash: Hash.nullable(),
    state: z.enum(["reading", "admitted", "skipped", "failed"]),
    reason: z
      .enum([
        "no_eligible_boundaries",
        "native_session_not_ready",
        "source_read_failed",
        "source_revision_unavailable",
      ])
      .nullable(),
    unknownTimeBoundaries: Count,
    normalized: z
      .array(
        z
          .object({
            sessionHash: Hash,
            boundaries: z
              .array(
                z
                  .object({ id: Id, inputHash: Hash, revisionHash: Hash, occurredAt: Timestamp })
                  .strict(),
              )
              .max(5_000),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export const CollectorCoverageManifestSchema = z
  .object({
    schemaVersion: z.literal("openpond.collectorCoverageManifest.v1"),
    jobId: Id,
    connectionId: Id,
    connectionRevision: z.number().int().positive(),
    machineId: Id,
    sourceInstanceId: Id,
    from: Timestamp.nullable(),
    to: Timestamp,
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
    listingComplete: z.boolean(),
    pendingOperations: Count,
    sessions: z.array(CollectorCoverageSessionSchema).max(10_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from !== null && Date.parse(value.from) >= Date.parse(value.to))
      ctx.addIssue({
        code: "custom",
        message: "Collector source window is empty.",
      });
    if (
      value.finishedAt !== null &&
      Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Collector finish time precedes its start.",
      });
    if (
      new Set(value.sessions.map((session) => session.sourceKeyHash)).size !==
      value.sessions.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Collector source inventory is duplicated.",
      });
    let boundaries = 0;
    for (const session of value.sessions)
      for (const normalized of session.normalized) {
        boundaries += normalized.boundaries.length;
        if (
          new Set(normalized.boundaries.map((boundary) => boundary.id)).size !==
          normalized.boundaries.length
        )
          ctx.addIssue({
            code: "custom",
            message: "Normalized source boundaries are duplicated.",
          });
        for (const boundary of normalized.boundaries)
          if (
            Date.parse(boundary.occurredAt) >= Date.parse(value.to) ||
            (value.from !== null &&
              Date.parse(boundary.occurredAt) < Date.parse(value.from))
          )
            ctx.addIssue({
              code: "custom",
              message:
                "Eligible boundary is outside the declared event-time window.",
            });
      }
    if (boundaries > 20_000)
      ctx.addIssue({
        code: "custom",
        message: "Collector coverage exceeds its bounded boundary inventory.",
      });
  });
export type CollectorCoverageManifest = z.infer<
  typeof CollectorCoverageManifestSchema
>;
export type CollectorCoverageSession = z.infer<
  typeof CollectorCoverageSessionSchema
>;

export const CollectorCoverageSummarySchema = z
  .object({
    jobId: Id,
    manifestHash: Hash,
    sourceInventoryHash: Hash,
    eligibleBoundaryHash: Hash,
    from: Timestamp.nullable(),
    to: Timestamp,
    finishedAt: Timestamp.nullable(),
    conversations: Count,
    eligibleTurns: Count,
    admittedSessions: Count,
    skippedSessions: Count,
    failedSessions: Count,
    unknownTimeBoundaries: Count,
    pendingOperations: Count,
    listingComplete: z.boolean(),
    complete: z.boolean(),
  })
  .strict();
export type CollectorCoverageSummary = z.infer<
  typeof CollectorCoverageSummarySchema
>;

export function hashCollectorEligibleBoundaries(
  input: Array<{ id: string; inputHash: string; revisionHash: string }>,
) {
  const boundaries = new Map(
    input.map((boundary) => [
      JSON.stringify([boundary.id, boundary.inputHash, boundary.revisionHash]),
      { id: boundary.id, inputHash: boundary.inputHash, revisionHash: boundary.revisionHash },
    ]),
  );
  const ordered = [...boundaries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, boundary]) => boundary);
  return { hash: contentHash(ordered), count: ordered.length };
}

export function summarizeCollectorCoverage(
  raw: CollectorCoverageManifest,
): CollectorCoverageSummary {
  const manifest = CollectorCoverageManifestSchema.parse(raw);
  const boundaries = hashCollectorEligibleBoundaries(
    manifest.sessions.flatMap((session) =>
      session.normalized.flatMap((normalized) => normalized.boundaries),
    ),
  );
  const unknownTimeBoundaries = manifest.sessions.reduce(
    (sum, session) => sum + session.unknownTimeBoundaries,
    0,
  );
  return CollectorCoverageSummarySchema.parse({
    jobId: manifest.jobId,
    manifestHash: contentHash(manifest),
    sourceInventoryHash: contentHash(
      manifest.sessions
        .map((session) => ({
          sourceKeyHash: session.sourceKeyHash,
          nativeRevisionHash: session.nativeRevisionHash,
          snapshots: session.normalized.map(
            (normalized) => normalized.sessionHash,
          ),
        }))
        .sort((a, b) => a.sourceKeyHash.localeCompare(b.sourceKeyHash)),
    ),
    eligibleBoundaryHash: boundaries.hash,
    from: manifest.from,
    to: manifest.to,
    finishedAt: manifest.finishedAt,
    conversations: manifest.sessions.length,
    eligibleTurns: boundaries.count,
    admittedSessions: manifest.sessions.filter(
      (session) => session.state === "admitted",
    ).length,
    skippedSessions: manifest.sessions.filter(
      (session) => session.state === "skipped",
    ).length,
    failedSessions: manifest.sessions.filter(
      (session) => session.state === "failed",
    ).length,
    unknownTimeBoundaries,
    pendingOperations: manifest.pendingOperations,
    listingComplete: manifest.listingComplete,
    complete:
      manifest.finishedAt !== null &&
      manifest.listingComplete &&
      manifest.pendingOperations === 0 &&
      unknownTimeBoundaries === 0 &&
      manifest.sessions.every(
        (session) =>
          session.nativeRevisionHash !== null &&
          (session.state === "admitted" ||
            (session.state === "skipped" &&
              session.reason === "no_eligible_boundaries")),
      ),
  });
}
