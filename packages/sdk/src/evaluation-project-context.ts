import { z } from "zod";

/** The selected Project revision is retained independently of model artifacts.
 * Hosts resolve and authorize this reference before admitting execution. */
export const EvaluationProjectContextSchema = z.object({
  id: z.string().trim().min(1).max(240),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetId: z.string().trim().min(1).max(240).nullable(),
}).strict();
export type EvaluationProjectContext = z.infer<typeof EvaluationProjectContextSchema>;

export const EvaluationMessagesSchema = z.array(z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(100_000),
}).strict()).max(100).superRefine((messages, context) => {
  if (messages.reduce((total, message) => total + message.content.length, 0) > 100_000)
    context.addIssue({ code: "custom", message: "Evaluation prompt exceeds 100,000 characters." });
});
