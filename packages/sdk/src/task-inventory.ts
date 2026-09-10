import { z } from "zod";
import type { GraderSpec } from "./taskset-draft-core.js";

const Id = z.string().trim().min(1).max(500);
export const TaskInventoryQuerySchema = z.object({
  projectId: Id.optional(), tasksetId: Id.optional(), draftId: Id.optional(), taskId: Id.optional(),
  query: z.string().trim().max(1_000).default(""),
  split: z.enum(["train", "validation", "test", "frozen_eval"]).optional(),
  after: z.string().min(1).max(2_000).optional(), limit: z.number().int().min(1).max(100).default(30),
}).strict();
export const TaskScoringSummarySchema = z.object({ id: Id, method: z.enum(["code", "judge", "human"]), required: z.boolean() });
export const TaskInventoryItemSchema = z.object({
  tasksetId: Id, tasksetName: z.string(), tasksetRevision: z.number().int().positive(), tasksetHash: z.string(),
  taskId: Id, ordinal: z.number().int().nonnegative(), title: z.string(), description: z.string(), split: z.string(),
  scoring: z.array(TaskScoringSummarySchema), configuration: z.enum(["configured", "needs_reward", "needs_checks"]),
  draftId: Id.nullable().default(null), modelId: Id.nullable().default(null),
});
export const TaskInventoryPageSchema = z.object({ items: z.array(TaskInventoryItemSchema).max(100), nextCursor: z.string().nullable() });
export type TaskInventoryQuery = z.infer<typeof TaskInventoryQuerySchema>;
export type TaskScoringSummary = z.infer<typeof TaskScoringSummarySchema>;
export type TaskInventoryItem = z.infer<typeof TaskInventoryItemSchema>;
export type TaskInventoryPage = z.infer<typeof TaskInventoryPageSchema>;

/** Discovery derives only from public task input, never private references. */
export function describeTaskInput(input: Record<string, unknown>, id: string) {
  const text = [input.instruction, input.prompt, input.request, input.question, input.message]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const explicitTitle = typeof input.title === "string" ? input.title.trim() : "";
  const description = text?.trim() ?? "";
  return { title: (explicitTitle || description || id).slice(0, 180), description: description.slice(0, 2_000) };
}
export function summarizeTaskScoring(graders: GraderSpec[]): TaskScoringSummary[] {
  return graders.map(grader => ({ id: grader.id, method: grader.kind === "model_judge" ? "judge" : grader.kind === "human" ? "human" : "code", required: grader.hardGate }));
}
export function taskConfiguration(graders: GraderSpec[]): TaskInventoryItem["configuration"] {
  if (!graders.some(grader => grader.kind !== "human")) return "needs_reward";
  if (graders.some(grader => grader.kind === "model_judge" && grader.calibrationStatus !== "passed")) return "needs_checks";
  return "configured";
}
