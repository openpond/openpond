import { z } from "zod";
import { PonderDesktopScopeSchema } from "./ponder-desktop.js";

export const PonderDesktopHandoffPresentationSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    scope: PonderDesktopScopeSchema,
    title: z.string().min(1),
    state: z.enum([
      "waiting",
      "ready",
      "dispatching",
      "admitted",
      "completed",
      "failed",
      "cancelled",
      "blocked",
      "attention",
    ]),
    reason: z.string().nullable(),
    cancellationRequested: z.boolean(),
    waitingForDesktop: z.boolean(),
    prerequisite: z
      .object({
        sessionId: z.string().min(1).nullable(),
        title: z.string().min(1),
        turnId: z.string().nullable(),
      })
      .strict(),
    successor: z
      .object({
        operationId: z.string().min(1),
        sessionId: z.string().nullable(),
        providerId: z.string().min(1),
        modelId: z.string().nullable(),
        workspaceLabel: z.string().min(1),
      })
      .strict(),
    workflow: z.object({ kind: z.literal("review"), preparationSessionId: z.string().nullable(), preparationState: z.string(), sourceReady: z.boolean(), preparationCleanupPending: z.boolean() }).strict().optional(),
    successCriteria: z.string().min(1),
    canEdit: z.boolean(),
    canCancel: z.boolean(),
  })
  .strict();
export type PonderDesktopHandoffPresentation = z.infer<
  typeof PonderDesktopHandoffPresentationSchema
>;
