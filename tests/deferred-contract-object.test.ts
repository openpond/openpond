import { expect, test } from "vitest";
import { z } from "zod";
import { deferredObject } from "../packages/contracts/src/deferred-object.js";

// Deferred training contracts must save startup allocations without changing
// validation, defaults, composition, or the JSON Schema exposed to consumers.
test("resolves a deferred contract shape once and preserves object semantics", () => {
  let constructions = 0;
  const shape = () => ({
    name: z.string().min(2),
    limits: z.object({ count: z.number().int().positive().default(3) }),
    enabled: z.boolean().default(true),
  });
  const eager = z.object(shape());
  const deferred = deferredObject(() => { constructions++; return shape(); });
  expect(constructions).toBe(0);
  for (const input of [
    { name: "job", limits: {}, extra: "stripped" },
    { name: "x", limits: { count: -1 } },
    { name: "job", limits: { count: 1.5 }, enabled: "yes" },
  ]) {
    const expected = eager.safeParse(input);
    const actual = deferred.safeParse(input);
    expect(actual.success).toBe(expected.success);
    if (actual.success && expected.success) expect(actual.data).toEqual(expected.data);
    if (!actual.success && !expected.success) expect(actual.error.issues).toEqual(expected.error.issues);
  }
  expect(constructions).toBe(1);
  expect(z.toJSONSchema(deferred)).toEqual(z.toJSONSchema(eager));
  expect(deferred.pick({ name: true }).parse({ name: "job" })).toEqual({ name: "job" });
  expect(deferred.partial().parse({})).toEqual(eager.partial().parse({}));
  expect(deferred.extend({ id: z.string() }).parse({ name: "job", limits: {}, id: "one" }))
    .toEqual(eager.extend({ id: z.string() }).parse({ name: "job", limits: {}, id: "one" }));
  expect(deferred.strict().safeParse({ name: "job", limits: {}, extra: true }).success).toBe(false);
  expect(deferred.refine(value => value.name !== "blocked").safeParse({ name: "blocked", limits: {} }).success).toBe(false);
  expect(constructions).toBe(1);
});
