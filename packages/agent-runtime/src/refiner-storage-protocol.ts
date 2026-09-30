import { z } from "zod";

const id = z.string().trim().min(1).max(191);
const cursor = z.object({ createdAt: z.string().min(1), id }).strict();
const artifactKind = z.enum([
  "trigger_decision", "route_decision", "refiner_outcome",
  "proposal", "targeted_validation", "apply_receipt",
]);

/** Scope is supplied by the host's fenced Work context, never by this payload. */
export const RefinerStorageActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("active_release"), workspaceId: id }).strict(),
  z.object({
    action: z.literal("put_artifact"), workspaceId: id,
    kind: artifactKind,
    artifact: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    action: z.literal("artifact_page"), workspaceId: id,
    kind: artifactKind,
    before: cursor.nullable(), limit: z.number().int().min(1).max(200),
  }).strict(),
  z.object({
    action: z.literal("pending_trigger_page"), workspaceId: id,
    before: cursor.nullable(), limit: z.number().int().min(1).max(200),
  }).strict(),
]);

export type RefinerStorageAction = z.infer<typeof RefinerStorageActionSchema>;
