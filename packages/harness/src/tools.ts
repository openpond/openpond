import { z } from "zod";

import { ReleaseHashSchema, ReleaseIdSchema } from "./common.js";

export const ToolDeclarationSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  description: z.string().trim().min(1).max(2_000),
  inputSchema: z.record(z.string(), z.unknown()),
  inputSchemaHash: ReleaseHashSchema,
  sideEffect: z.enum(["read", "write"]),
  timeoutMs: z.number().int().positive().max(3_600_000),
}).strict();

export const CapabilityRequirementSchema = z.object({
  id: ReleaseIdSchema,
  required: z.boolean(),
  scopes: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  portability: z.enum(["portable", "host_adapter", "local_only", "hosted_only"]),
}).strict();

export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;
