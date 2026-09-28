import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const validationEvidence = z.object({
  kind: z.enum(["structural", "visual", "test", "user_review"]),
  status: z.enum(["passed", "failed", "not_run"]),
  label: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(4_000).nullable().optional(),
  ref: z.string().trim().max(4_096).nullable().optional(),
});

/** Immutable Work output identity supplied by the child; tenant and lease scope come from the host. */
export const HostedOutputIdentitySchema = z.object({
  id,
  title: z.string().trim().min(1).max(240),
  sourceTaskId: id,
  sourceTurnId: id,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  contentType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().min(1).max(10_000_000),
  sha256,
  validation: z.array(validationEvidence).max(32),
}).strict();

export const HostedOutputBeginParamsSchema = z.object({
  sessionId: id,
  turnId: id,
  output: HostedOutputIdentitySchema,
}).strict();

export const HostedOutputChunkParamsSchema = z.object({
  uploadId: id,
  index: z.number().int().min(0).max(1024),
  offset: z.number().int().min(0).max(10_000_000),
  sha256,
  contentsBase64: z.string().min(1).max(131_072),
}).strict();

export const HostedOutputCompleteParamsSchema = z.object({ uploadId: id }).strict();

export const HostedSandboxOutputIdentitySchema = HostedOutputIdentitySchema.pick({
  id: true, title: true, sourceTaskId: true, sourceTurnId: true,
  revision: true, createdAt: true, validation: true,
});
export const HostedOutputSaveSandboxFileParamsSchema = z.object({
  sessionId: id, turnId: id,
  output: HostedSandboxOutputIdentitySchema,
  sandboxPath: z.string().trim().min(1).max(4_096),
}).strict();

export type HostedOutputIdentity = z.infer<typeof HostedOutputIdentitySchema>;
export type HostedSandboxOutputIdentity = z.infer<typeof HostedSandboxOutputIdentitySchema>;
