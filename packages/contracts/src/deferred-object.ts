import { z } from "zod";

/**
 * Keep optional domain shapes unallocated until validation or shape inspection.
 * This is an ordinary ZodObject, preserving composition and JSON Schema APIs.
 */
export function deferredObject<Shape extends z.ZodRawShape>(shape: () => Shape): z.ZodObject<Shape> {
  let resolved: Shape | undefined;
  // The public constructor erases its shape generic; the factory supplies it.
  return new z.ZodObject({
    type: "object",
    get shape() {
      return resolved ??= shape();
    },
  }) as z.ZodObject<Shape>;
}
