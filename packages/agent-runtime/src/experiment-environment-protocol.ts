import { z } from "zod";

/** A case owner supplies the immutable source and compute authority. The child
 * can request a lifecycle operation, never another module, sandbox or account. */
export const ExperimentEnvironmentParamsSchema = z.object({
  caseId: z.string().trim().min(1).max(191),
  admissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  ordinal: z.number().int().nonnegative(),
  operation: z.enum(["create", "reset", "step", "collect", "destroy"]),
  value: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().min(1).max(30_000),
}).strict();
