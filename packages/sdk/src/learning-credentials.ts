import { z } from "zod";
import { ReleaseIdSchema } from "@openpond/harness";
import { LearningRevisionRefSchema } from "@openpond/evals/learning";
import { TaskSplitSchema } from "@openpond/evals/tasksets";

/** Source credentials can submit evidence and feedback for one source only. */
export const LearningSourceCredentialSchema = z.object({
  id: ReleaseIdSchema,
  scope: ReleaseIdSchema,
  sourceId: ReleaseIdSchema,
  name: z.string().trim().min(1).max(100),
  keyPrefix: z.string().min(1).max(100),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
}).strict();
export type LearningSourceCredential = z.infer<typeof LearningSourceCredentialSchema>;
export const LearningSourceCredentialSecretSchema = z.string().regex(/^opk_key_[A-Za-z0-9]{16}_[A-Za-z0-9]{48}$/);

export const LearningSourceCredentialRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), scope: ReleaseIdSchema, sourceId: ReleaseIdSchema, name: z.string().trim().min(1).max(100), expiresAt: z.iso.datetime(), operationId: ReleaseIdSchema, apiKey: LearningSourceCredentialSecretSchema }).strict(),
  z.object({ action: z.literal("list"), scope: ReleaseIdSchema, sourceId: ReleaseIdSchema, afterId: ReleaseIdSchema.optional(), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  z.object({ action: z.literal("revoke"), scope: ReleaseIdSchema, sourceId: ReleaseIdSchema, id: ReleaseIdSchema }).strict(),
]);
export type LearningSourceCredentialRequest = z.infer<typeof LearningSourceCredentialRequestSchema>;
export const LearningSourceCredentialCreatedSchema = z.object({ credential: LearningSourceCredentialSchema, apiKey: LearningSourceCredentialSecretSchema }).strict();
export const LearningSourceCredentialPageSchema = z.object({ items: z.array(LearningSourceCredentialSchema).max(100), nextCursor: ReleaseIdSchema.nullable() }).strict();
export const LearningSourceConfigurationRequestSchema = z.object({ scope: ReleaseIdSchema, sourceId: ReleaseIdSchema }).strict();
export const LearningSourceConfigurationSchema = z.object({
  scope: ReleaseIdSchema, source: LearningRevisionRefSchema, taskDefinition: LearningRevisionRefSchema,
  enabled: z.boolean(), allowedSplits: z.array(TaskSplitSchema).min(1).max(4),
}).strict();

/** Keep this request in memory for retries. Hosts persist hashes, never its secret. */
export function createSourceCredentialRequest(input: { sourceId: string; name: string; expiresAt: string }) {
  return { ...input, operationId: crypto.randomUUID(), apiKey: `opk_key_${randomToken(16)}_${randomToken(48)}` };
}

function randomToken(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  while (value.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
      // Rejection sampling avoids modulo bias in the 62-character alphabet.
      if (byte < 248) value += alphabet[byte % 62];
      if (value.length === length) return value;
    }
  }
  return value;
}

/** Hosts enforce expiry when issuing and authenticating; tokens are never permanent. */
export function assertLearningCredentialExpiry(expiresAt: string, now: Date): void {
  const expires = Date.parse(z.iso.datetime().parse(expiresAt));
  if (expires <= now.getTime() || expires > now.getTime() + 90 * 24 * 60 * 60 * 1_000) throw new Error("Source credentials must expire within 90 days.");
}
