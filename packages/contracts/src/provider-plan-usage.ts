import { z } from "zod";

export const PlanUsageProviderSchema = z.enum(["claude-code", "codex"]);
export type PlanUsageProvider = z.infer<typeof PlanUsageProviderSchema>;
export const PlanUsageWindowSchema = z.object({
  id: z.string(), label: z.string(), remainingPercent: z.number().min(0).max(100),
  resetsAt: z.string().datetime().nullable(), shared: z.boolean(),
});
export type PlanUsageWindow = z.infer<typeof PlanUsageWindowSchema>;
export const ProviderPlanUsageSchema = z.object({
  provider: PlanUsageProviderSchema,
  status: z.enum(["ready", "unavailable", "signed_out", "unsupported"]),
  windows: z.array(PlanUsageWindowSchema),
  fetchedAt: z.string().datetime(), refreshAfter: z.string().datetime(), message: z.string().nullable(),
});
export type ProviderPlanUsage = z.infer<typeof ProviderPlanUsageSchema>;
