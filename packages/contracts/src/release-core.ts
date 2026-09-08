import { z } from "zod";

import { ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
export { ReleaseIdSchema, ReleaseHashSchema, ReleaseTimestampSchema, ImmutableReleaseRefSchema, VersionedReleaseRefSchema, type ImmutableReleaseRef, type VersionedReleaseRef } from "@openpond/harness";

export const ScopedSecretDeclarationSchema = z
  .object({
    id: ReleaseIdSchema,
    purpose: z.string().trim().min(1).max(500),
    audience: z.enum([
      "orchestrator",
      "environment",
      "privileged_scorer",
      "trainer",
      "infrastructure",
    ]),
    required: z.boolean(),
    ttlSeconds: z.number().int().positive().max(86_400),
    scopes: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  })
  .strict();

export const OpaqueSecretLeaseRefSchema = z
  .object({
    declarationId: ReleaseIdSchema,
    leaseRef: z.string().trim().min(8).max(1_000),
    audience: ScopedSecretDeclarationSchema.shape.audience,
    expiresAt: ReleaseTimestampSchema,
  })
  .strict();

export type ScopedSecretDeclaration = z.infer<
  typeof ScopedSecretDeclarationSchema
>;
export type OpaqueSecretLeaseRef = z.infer<typeof OpaqueSecretLeaseRefSchema>;
