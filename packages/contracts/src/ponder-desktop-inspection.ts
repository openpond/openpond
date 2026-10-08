import { z } from "zod";
const id = z.string().min(1).max(200);

/** A captured read may finish while its source task is still running. */
export const PonderDesktopInspectionSchema = z.object({
  operationId: id,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: id,
  sessionTitle: z.string().min(1).max(300),
  turnId: id,
  workspaceId: id,
  providerId: id,
  modelId: id.nullable(),
  capturedAt: z.string().datetime(),
  taskStatus: z.enum(["in_progress", "completed", "failed", "interrupted"]),
  taskCompletedAt: z.string().datetime().nullable(),
  error: z.string().max(2_000).nullable(),
  events: z.array(z.object({
    id,
    sequence: z.number().int().positive(),
    timestamp: z.string().max(100),
    kind: z.enum(["assistant.delta", "tool.started", "tool.completed"]),
    text: z.string().max(4_000),
    action: z.string().max(300).nullable(),
    status: z.enum(["started", "completed", "failed", "pending"]).nullable(),
    messageId: z.string().max(300).nullable(),
    messageSnapshot: z.boolean(),
  }).strict()).max(100),
  coverage: z.object({
    olderEventsOmitted: z.boolean(),
    textTruncated: z.boolean(),
    textLimit: z.literal(16_000),
    eventLimit: z.literal(100),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.events.reduce((total, event) => total + event.text.length, 0) > 16_000)
    ctx.addIssue({ code: "custom", message: "Inspection text exceeds its shared budget" });
  if (value.taskStatus === "in_progress" && value.taskCompletedAt !== null)
    ctx.addIssue({ code: "custom", message: "A running task cannot have a completion time" });
});
export type PonderDesktopInspection = z.infer<typeof PonderDesktopInspectionSchema>;
