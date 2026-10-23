import { z } from "zod";
export const Id = z.string().trim().min(1).max(500);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Ref = z.object({ id: Id, contentHash: Hash }).strict();
export const Revision = z.number().int().positive();
export const Empty = z.object({}).strict();
export const ById = z.object({ id: Id }).strict();
export const Cursor = z.object({ cursor: Id.optional() }).strict();
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
