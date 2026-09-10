import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { LearningJsonObjectSchema } from "./contracts.js";
import { TaskSplitSchema } from "../tasksets.js";

export const TASK_INTAKE_LIMITS = { bytes: 5 * 1024 * 1024, records: 1_000, files: 100, messages: 2_000 } as const;
export const TaskIntakeFormatSchema = z.enum(["json", "jsonl", "csv", "hermes", "openclaw"]);
export type TaskIntakeFormat = z.infer<typeof TaskIntakeFormatSchema>;
export const TaskIntakeFileSchema = z.object({ path: z.string().min(1).max(500), text: z.string() }).strict();
export const TaskIntakeRecordSchema = z.object({
  id: z.string().min(1).max(200), familyKey: z.string().min(1).max(200), split: TaskSplitSchema,
  kind: z.enum(["task", "attempt"]), input: LearningJsonObjectSchema,
  observedOutput: LearningJsonObjectSchema.nullable(), expected: LearningJsonObjectSchema.nullable(),
  sourceId: z.string().min(1).max(2_000), sourceHash: z.string().length(64),
  occurredAt: z.string().datetime().nullable(),
  // Imported labels and metadata are retained evidence, never admissions or
  // executable Rewards. Hosts store these outside policy-visible fields.
  metadata: LearningJsonObjectSchema, warnings: z.array(z.string().max(2_000)).max(100),
  needsContext: z.boolean(),
}).strict();
export type TaskIntakeRecord = z.infer<typeof TaskIntakeRecordSchema>;
export const TaskIntakePreviewSchema = z.object({
  schemaVersion: z.literal("openpond.taskIntakePreview.v1"), format: TaskIntakeFormatSchema,
  contentHash: z.string().length(64), records: z.array(TaskIntakeRecordSchema).max(TASK_INTAKE_LIMITS.records),
  issues: z.array(z.object({ file: z.string(), row: z.number().int().positive().nullable(), message: z.string() }).strict()).max(1_000),
}).strict();
export type TaskIntakePreview = z.infer<typeof TaskIntakePreviewSchema>;
export type TaskIntakeFile = z.infer<typeof TaskIntakeFileSchema>;
export function intakeId(source: string, identity: unknown): string { return `${source}-${contentHash(identity)}`; }
export function intakeDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(typeof value === "number" ? value * 1_000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
