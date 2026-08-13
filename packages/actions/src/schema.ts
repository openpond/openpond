import { z } from "zod";

import type { ProjectActionSchema } from "./types.js";

export function projectActionJsonSchema(schema: ProjectActionSchema): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
}

export function parseProjectActionValue(schema: ProjectActionSchema, value: unknown): unknown {
  return schema.parse(value);
}
