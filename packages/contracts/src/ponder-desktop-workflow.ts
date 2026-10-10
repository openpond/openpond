import { z } from "zod";

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Only metadata crosses the relay. Source bytes stay in the original desktop's artifact store. */
export const PonderDesktopSourceSchema = z
  .object({
    manifestHash: hash,
    workspaceId: id,
    sessionId: id,
    turnId: id,
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    fileCount: z.number().int().nonnegative().max(20_000),
  })
  .strict();
export type PonderDesktopSource = z.infer<typeof PonderDesktopSourceSchema>;

export const PonderDesktopWorkflowStepSchema = z
  .object({
    handoffId: id,
    title: z.string().trim().min(1).max(300),
    kind: z.literal("review"),
    role: z.enum(["preparation", "successor"]),
    prerequisiteOperationId: id,
    prerequisiteSessionId: id,
    preparationOperationId: id.optional(),
    source: PonderDesktopSourceSchema.optional(),
  })
  .strict();
export type PonderDesktopWorkflowStep = z.infer<typeof PonderDesktopWorkflowStepSchema>;
