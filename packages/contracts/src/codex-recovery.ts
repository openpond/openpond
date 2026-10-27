import { z } from "zod";

export const CodexRecoveryRequestSchema = z
  .object({
    failedTurnId: z.string().min(1),
    confirmedActiveTurnId: z.string().min(1).optional(),
  })
  .strict();
export type CodexRecoveryRequest = z.infer<typeof CodexRecoveryRequestSchema>;

export const CodexRecoveryResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("resumed") }),
  z.object({ state: z.literal("active"), activeTurnId: z.string() }),
  z.object({ state: z.literal("external"), threadId: z.string() }),
  z.object({ state: z.literal("superseded") }),
]);
export type CodexRecoveryResponse = z.infer<typeof CodexRecoveryResponseSchema>;
