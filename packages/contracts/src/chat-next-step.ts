import { z } from "zod";
import { ChatContextSelectionSchema } from "./chat-context-selection.js";
import { TaskResourceContextsSchema } from "./task-inbox.js";

export const ChatNextStepActionSchema = z.enum(["prepare_evaluation", "check_graders", "inspect_results", "diagnose", "compare"]);
export const ChatNextStepSchema = z.object({
  id: z.string(), sessionId: z.string(), sourceTurnId: z.string(),
  action: ChatNextStepActionSchema, label: z.string(), draft: z.string(),
  contexts: TaskResourceContextsSchema,
  focus: ChatContextSelectionSchema,
}).strict();
export type ChatNextStep = z.infer<typeof ChatNextStepSchema>;
export type ChatNextStepAction = z.infer<typeof ChatNextStepActionSchema>;
