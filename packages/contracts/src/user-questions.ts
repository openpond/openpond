import { z } from "zod";

export const SessionUserQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional().default(null),
});

export const SessionUserQuestionSchema = z.object({
  id: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  toolCallId: z.string().trim().min(1),
  question: z.string().trim().min(1).max(2_000),
  reason: z.string().trim().max(1_000).nullable().optional().default(null),
  options: z.array(SessionUserQuestionOptionSchema).max(5).default([]),
  allowFreeform: z.boolean().default(true),
  status: z.enum(["pending", "answered", "dismissed"]),
  answer: z.object({
    optionId: z.string().trim().min(1).nullable(),
    text: z.string().max(4_000),
  }).nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
});

export const SessionUserQuestionResolutionSchema = z.object({
  questionId: z.string().trim().min(1),
  action: z.enum(["answer", "dismiss"]),
  optionId: z.string().trim().min(1).nullable().optional().default(null),
  text: z.string().trim().max(4_000).optional().default(""),
});

export type SessionUserQuestionOption = z.infer<typeof SessionUserQuestionOptionSchema>;
export type SessionUserQuestion = z.infer<typeof SessionUserQuestionSchema>;
export type SessionUserQuestionResolution = z.infer<typeof SessionUserQuestionResolutionSchema>;
