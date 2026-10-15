import { z } from "zod";
import { ChatResourceSummarySchema } from "./chat-resources.js";
import { ChatTrainingAttachmentSchema } from "./chat-training-resources.js";

export const ChatContextTargetSchema = z.object({
  kind: z.enum(["dataset", "experiment", "model", "training"]),
  id: z.string().trim().min(1).max(240),
  revision: z.number().int().positive().optional(),
  location: z.enum(["local", "cloud"]).default("local"),
  teamId: z.string().min(1).max(240).optional(),
  apiOrigin: z.url().max(2000).optional(),
  scopeId: z.string().min(1).max(240).optional(),
  sessionId: z.string().min(1).max(240).optional(),
}).strict();
export const ChatContextOptionSchema = z.object({
  target: ChatContextTargetSchema, label: z.string().max(500), detail: z.string().max(2000),
}).strict();
export const ChatContextSelectionSchema = ChatContextOptionSchema.extend({
  resource: ChatResourceSummarySchema.optional(),
  dataset: ChatResourceSummarySchema.optional(),
  graders: z.array(ChatResourceSummarySchema).optional(),
  training: ChatTrainingAttachmentSchema.optional(),
  model: z.object({ id: z.string(), name: z.string(), portableProjectId: z.string(), baseModel: z.string().nullable(),
    trainingDataset: z.object({ id: z.string(), revision: z.number().int().positive(), name: z.string() }).nullable(),
    evaluationDataset: z.object({ id: z.string(), revision: z.number().int().positive(), name: z.string() }).nullable(),
  }).strict().optional(),
}).strict();
export type ChatContextTarget = z.infer<typeof ChatContextTargetSchema>;
export type ChatContextOption = z.infer<typeof ChatContextOptionSchema>;
export type ChatContextSelection = z.infer<typeof ChatContextSelectionSchema>;
