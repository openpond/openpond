import { z } from "zod";

const id = z.string().trim().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const kind = z.enum(["run_overlay", "observation", "trigger_decision", "route_decision",
  "proposal", "targeted_validation", "apply_receipt", "refiner_outcome"]);
const cursor = z.object({ createdAt: z.string().datetime(), id }).strict();
/** Review authority is the host's current owner lease; payloads cannot select a tenant. */
export const HarnessReviewStorageParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("artifact_put"), workspaceId: id, kind,
    artifact: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("artifact_page"), workspaceId: id, kind,
    before: cursor.nullable(), limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal("pending_page"), workspaceId: id,
    before: cursor.nullable(), limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal("workspace_get"), workspaceId: id }).strict(),
  z.object({ action: z.literal("background_get"), workspaceId: id }).strict(),
  z.object({ action: z.literal("overlay_get"), runId: id }).strict(),
  z.object({ action: z.literal("overlay_freeze"), runId: id, expectedRevision: z.number().int().nonnegative(),
    overlay: z.record(z.string(), z.unknown()), proposal: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("memory_get"), workspaceId: id, sessionId: id, key: id }).strict(),
  z.object({ action: z.literal("memory_page"), workspaceId: id, sessionId: id,
    before: z.object({ updatedAt: z.string().datetime(), key: id }).strict().nullable(),
    limit: z.number().int().min(1).max(20), includeDeleted: z.boolean() }).strict(),
  z.object({ action: z.literal("memory_write"), sessionId: id, input: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("release_get"), contentHash: hash }).strict(),
  z.object({ action: z.literal("release_put"), record: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("session_get"), sessionId: id }).strict(),
  z.object({ action: z.literal("turn_get"), turnId: id }).strict(),
  z.object({ action: z.literal("turn_page"), sessionId: id, before: z.number().int().positive().nullable(),
    limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal("event_page"), turnId: id, afterSequence: z.number().int().nonnegative(),
    names: z.array(id).max(40), limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal("event_append"), event: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("usage_put"), record: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("snapshot_restore"), turnId: id, expectedHash: hash,
    snapshot: z.record(z.string(), z.unknown()) }).strict(),
]);
