import { z } from "zod";

export const ReleaseIdSchema = z.string().trim().min(1).max(240);
export const ReleaseHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ReleaseTimestampSchema = z.string().datetime({ offset: true });

export const ImmutableReleaseRefSchema = z
  .object({
    id: ReleaseIdSchema,
    contentHash: ReleaseHashSchema,
  })
  .strict();

export const VersionedReleaseRefSchema = ImmutableReleaseRefSchema.extend({
  revision: z.number().int().positive(),
}).strict();

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

export type ImmutableReleaseRef = z.infer<typeof ImmutableReleaseRefSchema>;
export type VersionedReleaseRef = z.infer<typeof VersionedReleaseRefSchema>;
export type ScopedSecretDeclaration = z.infer<
  typeof ScopedSecretDeclarationSchema
>;
export type OpaqueSecretLeaseRef = z.infer<typeof OpaqueSecretLeaseRefSchema>;
