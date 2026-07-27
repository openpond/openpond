import { z } from "zod";

import {
  ImmutableReleaseRefSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
} from "./release-core.js";

export const HarnessActionBindingSchema = z
  .object({
    schemaVersion: z.literal("openpond.harnessActionBinding.v1"),
    actionId: ReleaseIdSchema,
    modelToolName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    description: z.string().trim().min(1).max(1_000),
    inputSchema: z.record(z.string(), z.unknown()),
    actionSchemaHash: ReleaseHashSchema,
    agentRelease: ImmutableReleaseRefSchema,
    implementationHash: ReleaseHashSchema,
    runtimeBindingId: ReleaseIdSchema,
    capabilityReceiptHash: ReleaseHashSchema,
    sideEffect: z.enum(["read", "write"]),
    studentVisible: z.boolean(),
    timeoutMs: z.number().int().positive().max(3_600_000),
    episodeArgumentBindings: z
      .array(
        z
          .object({
            argument: ReleaseIdSchema,
            source: z.literal("case_id"),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

export type HarnessActionBinding = z.infer<typeof HarnessActionBindingSchema>;
