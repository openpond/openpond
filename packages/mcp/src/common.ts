import { z } from "zod";
import { OpenPondProtocolError } from "openpond-sdk/training";
import type { OpenPondMcpContext } from "./types.js";
export const Id = z.string().trim().min(1).max(500);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Ref = z.object({ id: Id, contentHash: Hash }).strict();
export const Revision = z.number().int().positive();
export const Empty = z.object({}).strict();
export const ById = z.object({ id: Id }).strict();
export const Cursor = z.object({ cursor: Id.optional() }).strict();
/** Keep field schemas while binding workspace before the SDK reparses its full
 * refined request. Zod omit() cannot be applied to refined object schemas. */
export function withoutWorkspace<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const { teamId: _teamId, ...shape } = schema.shape;
  return z.strictObject(shape);
}
/** The SDK validates hashes and request identities; additionally bind private
 * draft/funding responses to the OAuth principal the host actually verified. */
export function verifyPrincipal<
  T extends { teamId: string; ownerUserId?: string; actorId?: string },
>(result: T, context: OpenPondMcpContext): T {
  if (
    result.teamId !== context.teamId ||
    (result.ownerUserId !== undefined && result.ownerUserId !== context.userId) ||
    (result.actorId !== undefined && result.actorId !== context.userId)
  )
    throw new OpenPondProtocolError(
      "response_scope_mismatch",
      "The response belongs to another authorized principal.",
    );
  return result;
}
export const Window = z
  .object({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
/** Offset is over immutable append-only evidence. Follow-up never launches work. */
export function page<T>(items: T[], after: number, limit: number) {
  const result = items.slice(after, after + limit);
  return {
    items: result,
    nextOffset: after + result.length < items.length ? after + result.length : null,
  };
}
