import { z } from "zod";

/** Strict function-calling clients may send null for an omitted optional field.
 * Normalize only where this exact property accepts omission and rejects null;
 * the original schema still validates the complete result before dispatch.
 * Unions, transforms, records and lazy schemas remain opaque: selecting or
 * rewriting one possible branch could change the meaning of caller input. */
export function normalizeOptionalNulls(schema: z.core.$ZodType, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodReadonly
  )
    return normalizeOptionalNulls(schema.unwrap(), value);
  if (schema instanceof z.ZodArray && Array.isArray(value))
    return value.map((item) => normalizeOptionalNulls(schema.element, item));
  if (!(schema instanceof z.ZodObject) || Array.isArray(value)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const original = value as Record<string, unknown>;
  let normalized: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(original)) {
    if (!Object.hasOwn(schema.shape, key)) continue;
    const property = schema.shape[key] as z.core.$ZodType;
    if (
      item === null &&
      !z.safeParse(property, null).success &&
      z.safeParse(property, undefined).success
    ) {
      normalized ??= { ...original };
      delete normalized[key];
      continue;
    }
    const next = normalizeOptionalNulls(property, item);
    if (next !== item) {
      normalized ??= { ...original };
      normalized[key] = next;
    }
  }
  return normalized ?? original;
}
