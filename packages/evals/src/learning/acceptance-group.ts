import { z } from "zod";
import { assertContentHash, contentHash, ImmutableReleaseRefSchema } from "@openpond/harness";
import { AcceptanceMeasurementSchema, AcceptancePlanSchema, evaluateAcceptancePlan } from "./acceptance-plan.js";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime();
const Money = z.number().finite().nonnegative();
const terminalAttempts = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const terminalGroups = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const groupTransitions: Record<string, string[]> = {
  queued: ["queued", "running", "blocked", "cancelling", "failed", "budget_exhausted"],
  running: ["running", "blocked", "cancelling", "cleaning", "completed", "failed", "budget_exhausted"],
  blocked: ["blocked", "running", "cancelling", "failed", "budget_exhausted"],
  cancelling: ["cancelling", "cleaning", "cancelled", "budget_exhausted"],
  cleaning: ["cleaning", "completed", "failed", "cancelled", "budget_exhausted"],
};
const attemptTransitions: Record<string, string[]> = {
  queued: ["queued", "dispatching", "failed", "cancelled", "budget_exhausted"],
  dispatching: ["dispatching", "running", "cleaning", "failed", "cancelled", "budget_exhausted"],
  running: ["running", "grading", "cleaning", "failed", "cancelled", "budget_exhausted"],
  grading: ["grading", "cleaning", "completed", "failed", "cancelled", "budget_exhausted"],
  cleaning: ["cleaning", "completed", "failed", "cancelled", "budget_exhausted"],
};

/** A group starts only after the exact candidate is available. The host must pin
 * its acceptance plan before training admission so a missing group blocks review. */
export const AcceptanceGroupManifestContentSchema = z.object({
  schemaVersion: z.literal("openpond.acceptanceGroupManifest.v1"),
  id: Id, teamId: Id, trainingJob: ImmutableReleaseRefSchema,
  baseline: ImmutableReleaseRefSchema, candidate: ImmutableReleaseRefSchema,
  plan: AcceptancePlanSchema, maximumParallelAttempts: z.number().int().min(1).max(8),
  createdAt: Timestamp,
}).strict().superRefine((manifest, ctx) => {
  if (manifest.plan.checks.some(check => !check.role || !check.unit))
    ctx.addIssue({ code: "custom", message: "Durable acceptance checks require explicit roles and score units." });
});
export const AcceptanceGroupManifestSchema = AcceptanceGroupManifestContentSchema.safeExtend({ contentHash: Hash });
export type AcceptanceGroupManifest = z.infer<typeof AcceptanceGroupManifestSchema>;

export const AcceptanceAttemptSchema = z.object({
  id: Id, checkId: Id, subject: z.enum(["baseline", "candidate"]),
  ordinal: z.number().int().positive(), dispatchId: Id,
  state: z.enum(["queued", "dispatching", "running", "grading", "cleaning", "completed", "failed", "cancelled", "budget_exhausted"]),
  artifact: ImmutableReleaseRefSchema, checkHash: Hash,
  measurement: AcceptanceMeasurementSchema.nullable(),
  executionReceipt: ImmutableReleaseRefSchema.nullable(),
  reusedFrom: z.object({ group: ImmutableReleaseRefSchema, attemptId: Id }).strict().nullable(),
  spendUsd: Money, reservedUsd: Money,
  cleanupComplete: z.boolean(), accountingComplete: z.boolean(),
  failureCode: Id.nullable(), createdAt: Timestamp, updatedAt: Timestamp,
}).strict().superRefine((attempt, ctx) => {
  if (Date.parse(attempt.updatedAt) < Date.parse(attempt.createdAt))
    ctx.addIssue({ code: "custom", message: "Attempt timestamps are reversed." });
  if (terminalAttempts.has(attempt.state) && (!attempt.cleanupComplete || !attempt.accountingComplete || attempt.reservedUsd !== 0))
    ctx.addIssue({ code: "custom", message: "Terminal attempts require cleanup and settled accounting." });
  if (attempt.state === "completed" && (attempt.measurement?.status !== "completed" || !attempt.executionReceipt))
    ctx.addIssue({ code: "custom", message: "Completed attempts require retained measurement and execution receipts." });
  if (attempt.reusedFrom && (attempt.subject !== "baseline" || attempt.state !== "completed" || attempt.spendUsd !== 0))
    ctx.addIssue({ code: "custom", message: "Only completed baselines may reuse retained evidence without new spend." });
});
export type AcceptanceAttempt = z.infer<typeof AcceptanceAttemptSchema>;

export const AcceptanceGroupSnapshotContentSchema = z.object({
  schemaVersion: z.literal("openpond.acceptanceGroupSnapshot.v1"),
  manifest: AcceptanceGroupManifestSchema,
  revision: z.number().int().positive(),
  state: z.enum(["queued", "running", "blocked", "cancelling", "cleaning", "completed", "failed", "cancelled", "budget_exhausted"]),
  attempts: z.array(AcceptanceAttemptSchema).max(2_000),
  failureCode: Id.nullable(), updatedAt: Timestamp,
}).strict();
export const AcceptanceGroupSnapshotSchema = AcceptanceGroupSnapshotContentSchema.extend({ contentHash: Hash });
export type AcceptanceGroupSnapshot = z.infer<typeof AcceptanceGroupSnapshotSchema>;

export function createAcceptanceGroupManifest(raw: z.input<typeof AcceptanceGroupManifestContentSchema>): AcceptanceGroupManifest {
  const content = AcceptanceGroupManifestContentSchema.parse(raw);
  assertContentHash(content.plan, "Acceptance plan");
  return { ...content, contentHash: contentHash(content) };
}

export function createAcceptanceGroupSnapshot(raw: z.input<typeof AcceptanceGroupSnapshotContentSchema>): AcceptanceGroupSnapshot {
  const content = AcceptanceGroupSnapshotContentSchema.parse(raw);
  return assertAcceptanceGroupSnapshot({ ...content, contentHash: contentHash(content) });
}

/** Structural integrity does not replace receipt retrieval, resource access,
 * qualification/revocation checks, or authoritative ledger verification. */
export function assertAcceptanceGroupSnapshot(raw: unknown): AcceptanceGroupSnapshot {
  const snapshot = AcceptanceGroupSnapshotSchema.parse(raw);
  assertContentHash(snapshot, "Acceptance group snapshot");
  assertContentHash(snapshot.manifest, "Acceptance group manifest");
  assertContentHash(snapshot.manifest.plan, "Acceptance plan");
  const checks = new Map(snapshot.manifest.plan.checks.map(check => [check.id, check]));
  const identities = new Set<string>(), dispatches = new Set<string>(), positions = new Set<string>();
  for (const attempt of snapshot.attempts) {
    const check = checks.get(attempt.checkId);
    if (!check || attempt.checkHash !== contentHash(check) || contentHash(attempt.artifact) !== contentHash(snapshot.manifest[attempt.subject]))
      throw new Error("Acceptance attempt does not match its pinned check and artifact.");
    const position = JSON.stringify([attempt.checkId, attempt.subject, attempt.ordinal]);
    if (identities.has(attempt.id) || dispatches.has(attempt.dispatchId) || positions.has(position))
      throw new Error("Acceptance attempts require unique identities, dispatches and positions.");
    identities.add(attempt.id); dispatches.add(attempt.dispatchId); positions.add(position);
    if (attempt.measurement && (attempt.measurement.checkHash !== attempt.checkHash || contentHash(attempt.measurement.artifact) !== contentHash(attempt.artifact)))
      throw new Error("Acceptance measurement does not match its attempt.");
    if (attempt.reusedFrom && !check.baselineReuse)
      throw new Error("This check does not permit baseline reuse.");
  }
  for (const check of checks.values()) for (const subject of ["baseline", "candidate"] as const) {
    const attempts = snapshot.attempts.filter(attempt => attempt.checkId === check.id && attempt.subject === subject).sort((a, b) => a.ordinal - b.ordinal);
    attempts.forEach((attempt, index) => {
      if (attempt.ordinal !== index + 1 || (index > 0 && (!terminalAttempts.has(attempts[index - 1]!.state) || attempts[index - 1]!.state === "completed")))
        throw new Error("Retries must follow a settled failed attempt; completed evidence requires a new group to rerun.");
    });
  }
  if (terminalGroups.has(snapshot.state) && snapshot.attempts.some(attempt => !terminalAttempts.has(attempt.state)))
    throw new Error("Terminal groups cannot retain unsettled attempts.");
  if (snapshot.attempts.filter(attempt => !terminalAttempts.has(attempt.state) && attempt.state !== "queued").length > snapshot.manifest.maximumParallelAttempts)
    throw new Error("Acceptance attempts exceed the declared concurrency limit.");
  if (Date.parse(snapshot.updatedAt) < Date.parse(snapshot.manifest.createdAt) || snapshot.attempts.some(attempt => Date.parse(attempt.createdAt) < Date.parse(snapshot.manifest.createdAt) || Date.parse(attempt.updatedAt) > Date.parse(snapshot.updatedAt)))
    throw new Error("Acceptance group timestamps do not contain their attempts.");
  if (snapshot.state === "completed" && snapshot.manifest.plan.checks.some(check =>
    ["baseline", "candidate"].some(subject => !snapshot.attempts.some(attempt => attempt.checkId === check.id && attempt.subject === subject))))
    throw new Error("Completed groups require an attempt for each declared check and subject.");
  return snapshot;
}

/** Runtime retries append history. A terminal group is immutable; deliberate
 * reruns create a new manifest and cannot silently replace reviewed evidence. */
export function assertAcceptanceGroupUpdate(previousRaw: unknown, nextRaw: unknown): AcceptanceGroupSnapshot {
  const previous = assertAcceptanceGroupSnapshot(previousRaw), next = assertAcceptanceGroupSnapshot(nextRaw);
  if (previous.manifest.contentHash !== next.manifest.contentHash || next.revision !== previous.revision + 1 || terminalGroups.has(previous.state))
    throw new Error("Acceptance group revision or immutable identity changed.");
  if (!groupTransitions[previous.state]?.includes(next.state)) throw new Error("Invalid acceptance group transition.");
  if (["cancelling", "cleaning"].includes(previous.state) && next.attempts.length !== previous.attempts.length)
    throw new Error("Stopping groups cannot dispatch additional attempts.");
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new Error("Acceptance group time moved backwards.");
  const priorIds = new Set(previous.attempts.map(attempt => attempt.id));
  for (const added of next.attempts.filter(attempt => !priorIds.has(attempt.id))) {
    if (added.state !== "queued" && !(added.state === "completed" && added.reusedFrom))
      throw new Error("New attempts must enter the queue or retain an explicitly reused baseline.");
    if (Date.parse(added.createdAt) < Date.parse(previous.updatedAt))
      throw new Error("New attempts cannot predate the preceding group revision.");
  }
  for (const before of previous.attempts) {
    const after = next.attempts.find(attempt => attempt.id === before.id);
    if (!after || after.checkId !== before.checkId || after.subject !== before.subject || after.ordinal !== before.ordinal || after.dispatchId !== before.dispatchId || after.createdAt !== before.createdAt || after.checkHash !== before.checkHash || contentHash(after.reusedFrom) !== contentHash(before.reusedFrom) || contentHash(after.artifact) !== contentHash(before.artifact))
      throw new Error("Acceptance attempt identity or history changed.");
    if (after.spendUsd < before.spendUsd || Date.parse(after.updatedAt) < Date.parse(before.updatedAt) || (terminalAttempts.has(before.state) && contentHash(before) !== contentHash(after)))
      throw new Error("Settled acceptance evidence and spend cannot be rewritten.");
    if (!terminalAttempts.has(before.state) && !attemptTransitions[before.state]?.includes(after.state))
      throw new Error("Invalid acceptance attempt transition.");
  }
  const admitsWork = next.attempts.some(after => after.state === "dispatching" && previous.attempts.find(before => before.id === after.id)?.state === "queued");
  if (admitsWork) {
    const committed = (attempt: AcceptanceAttempt) => attempt.spendUsd + attempt.reservedUsd;
    if (next.attempts.reduce((sum, attempt) => sum + committed(attempt), 0) > next.manifest.plan.maximumSpendUsd + 1e-9 ||
        next.manifest.plan.checks.some(check => next.attempts.filter(attempt => attempt.checkId === check.id).reduce((sum, attempt) => sum + committed(attempt), 0) > check.maximumSpendUsd + 1e-9))
      throw new Error("Dispatch exceeds the pinned acceptance budget, including outstanding reservations and retry spend.");
  }
  return next;
}

/** Hosts additionally resolve the qualification reference and check current
 * revocation/access. This verifier rejects stale or differently configured
 * cached measurements without requiring the source candidate to have passed. */
export function assertAcceptanceBaselineReuse(input: {
  sourceGroup: unknown; targetManifest: unknown; checkId: string; attemptId: string; now: string;
}): AcceptanceAttempt {
  const source = assertAcceptanceGroupSnapshot(input.sourceGroup);
  const target = AcceptanceGroupManifestSchema.parse(input.targetManifest);
  assertContentHash(target, "Acceptance group manifest");
  assertContentHash(target.plan, "Acceptance plan");
  const check = target.plan.checks.find(value => value.id === input.checkId);
  const attempt = source.attempts.find(value => value.id === input.attemptId);
  const now = Date.parse(Timestamp.parse(input.now));
  if (!check?.baselineReuse || !attempt || !terminalGroups.has(source.state) || source.manifest.id === target.id || source.manifest.teamId !== target.teamId || attempt.state !== "completed" || !attempt.measurement || attempt.reusedFrom || !attempt.cleanupComplete || !attempt.accountingComplete)
    throw new Error("This retained attempt is not eligible for baseline reuse.");
  if (attempt.checkId !== check.id || attempt.checkHash !== contentHash(check) || contentHash(attempt.artifact) !== contentHash(target.baseline) || now < Date.parse(attempt.updatedAt) || now - Date.parse(attempt.updatedAt) > check.baselineReuse.maximumAgeSeconds * 1_000)
    throw new Error("Baseline reuse requires the exact artifact, check, qualification and freshness window.");
  const measurement = attempt.measurement;
  if (measurement.status !== "completed" || measurement.score === null || measurement.scoredCount / measurement.expectedCount < check.minimumCoverage || measurement.populationHash !== check.populationHash || measurement.executionHash !== check.executionHash || contentHash(measurement.evaluator) !== contentHash(check.evaluator) || measurement.metric !== check.metric)
    throw new Error("Baseline reuse requires complete compatible retained measurements.");
  return attempt;
}

export function acceptanceGroupVerdict(raw: unknown) {
  const snapshot = assertAcceptanceGroupSnapshot(raw);
  const { manifest } = snapshot;
  const latest = (checkId: string, subject: "baseline" | "candidate") => snapshot.attempts
    .filter(attempt => attempt.checkId === checkId && attempt.subject === subject)
    .sort((a, b) => b.ordinal - a.ordinal)[0];
  const measurements = manifest.plan.checks.map(check => ({
    checkId: check.id,
    baseline: latest(check.id, "baseline")?.measurement ?? null,
    candidate: latest(check.id, "candidate")?.measurement ?? null,
  }));
  const verdict = evaluateAcceptancePlan({ plan: manifest.plan, baseline: manifest.baseline, candidate: manifest.candidate, measurements });
  const reasons: string[] = [];
  if (snapshot.state !== "completed") reasons.push("group_not_completed");
  if (snapshot.attempts.some(attempt => !attempt.cleanupComplete || !attempt.accountingComplete || attempt.reservedUsd !== 0)) reasons.push("cleanup_or_accounting_incomplete");
  const spendUsd = snapshot.attempts.reduce((sum, attempt) => sum + attempt.spendUsd, 0);
  if (spendUsd > manifest.plan.maximumSpendUsd + 1e-9 || manifest.plan.checks.some(check => snapshot.attempts.filter(attempt => attempt.checkId === check.id).reduce((sum, attempt) => sum + attempt.spendUsd, 0) > check.maximumSpendUsd + 1e-9)) reasons.push("acceptance_budget_exceeded");
  for (const check of manifest.plan.checks.filter(check => check.required))
    if (["baseline", "candidate"].some(subject => latest(check.id, subject as "baseline" | "candidate")?.state !== "completed")) reasons.push("required_attempt_incomplete");
  return { ...verdict, passed: verdict.passed && reasons.length === 0, reasons: [...new Set(reasons)], spendUsd };
}
