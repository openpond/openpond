import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "../task-schema.js";
import { TaskSplitSchema } from "../tasksets.js";
import { LearningJsonObjectSchema } from "./contracts.js";
import { parseTaskIntakeCsv } from "./intake-csv.js";
import { parseHermesSession, parseOpenClawBundle } from "./intake-history.js";
import { intakeDate, intakeId, TASK_INTAKE_LIMITS, TaskIntakeFileSchema, TaskIntakeFormatSchema, TaskIntakeRecordSchema,
  TaskIntakePreviewSchema, type TaskIntakeFile, type TaskIntakeFormat, type TaskIntakePreview, type TaskIntakeRecord } from "./intake-contracts.js";

const taskSchema = z.object({
  instruction: z.string().trim().min(1).max(100_000), context: z.union([z.string(), LearningJsonObjectSchema]).optional(),
  reference: z.union([z.string(), LearningJsonObjectSchema]).optional(), labels: z.union([z.string(), z.array(z.string()), LearningJsonObjectSchema]).optional(),
  id: z.string().min(1).max(200).optional(), familyKey: z.string().min(1).max(200).optional(), split: TaskSplitSchema.optional(),
}).strict();
const structuredTaskSchema = z.object({
  input: LearningJsonObjectSchema, observedOutput: LearningJsonObjectSchema.nullable().optional(), expectedOutput: LearningJsonObjectSchema.nullable().optional(),
  id: z.string().min(1).max(200).optional(), familyKey: z.string().min(1).max(200).optional(), split: TaskSplitSchema.optional(),
  occurredAt: z.string().datetime().optional(), labels: LearningJsonObjectSchema.optional(),
}).strict();

export function previewTaskIntake(input: { format: TaskIntakeFormat; files: TaskIntakeFile[] }): TaskIntakePreview {
  const format = TaskIntakeFormatSchema.parse(input.format);
  const files = z.array(TaskIntakeFileSchema).min(1).max(TASK_INTAKE_LIMITS.files).parse(input.files);
  if (files.reduce((size, file) => size + new TextEncoder().encode(file.text).length, 0) > TASK_INTAKE_LIMITS.bytes) throw new Error("Import exceeds the 5 MiB size limit.");
  if (files.some(file => file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === "..")) || new Set(files.map(file => file.path)).size !== files.length) throw new Error("Import contains an unsafe or duplicate file path.");
  const records: TaskIntakeRecord[] = [], issues: TaskIntakePreview["issues"] = [];
  const seen = new Map<string, string>();
  const splits = new Map<string, string>();
  let normalizedBytes = 0;
  function attempt(file: string, row: number | null, parse: () => TaskIntakeRecord[]) {
    try {
      const parsed = parse();
      if (records.length + parsed.length > TASK_INTAKE_LIMITS.records) throw new Error("Import exceeds the 1,000-record limit.");
      const nextSeen = new Map(seen), nextSplits = new Map(splits);
      let addedBytes = 0;
      for (const record of parsed) {
        assertBoundedTaskJson(record);
        const hash = contentHash(record);
        const existing = nextSeen.get(record.id);
        if (existing && existing !== hash) throw new Error("The same record identity has different content in this upload.");
        if (!existing) addedBytes += new TextEncoder().encode(JSON.stringify(record)).length;
        nextSeen.set(record.id, hash);
        for (const key of [`family:${record.familyKey}`, `input:${contentHash(record.input)}`]) {
          if (nextSplits.has(key) && nextSplits.get(key) !== record.split) throw new Error("The same task family or request occurs in different splits.");
          nextSplits.set(key, record.split);
        }
      }
      if (normalizedBytes + addedBytes > TASK_INTAKE_LIMITS.bytes * 2) throw new Error("Expanded import exceeds the 10 MiB preview limit. Select fewer source files.");
      for (const record of parsed) { if (!seen.has(record.id)) records.push(record); seen.set(record.id, contentHash(record)); }
      for (const [key, split] of nextSplits) splits.set(key, split);
      normalizedBytes += addedBytes;
    } catch (error) {
      issues.push({ file, row, message: error instanceof z.ZodError ? `Unsupported record fields or values (${error.issues.slice(0, 3).map(issue => issue.path.join(".") || "record").join(", ")}).` : error instanceof SyntaxError ? "Invalid JSON." : error instanceof Error ? error.message : "Invalid import record." });
    }
  }
  if (format === "openclaw") attempt("manifest.json", null, () => parseOpenClawBundle(files));
  else for (const file of files) {
    if (format === "jsonl" || format === "hermes") {
      for (const [index, line] of file.text.split(/\r?\n/u).entries()) {
        if (!line.trim()) continue;
        if (issues.length >= TASK_INTAKE_LIMITS.records) break;
        attempt(file.path, index + 1, () => format === "hermes" ? parseHermesSession(JSON.parse(line)) : [normalizeTask(JSON.parse(line))]);
      }
    } else {
      let values: unknown[];
      try { const value: unknown = format === "csv" ? parseTaskIntakeCsv(file.text) : JSON.parse(file.text); values = Array.isArray(value) ? value : [value]; }
      catch (error) { attempt(file.path, null, () => { throw error; }); continue; }
      if (values.length > TASK_INTAKE_LIMITS.records) { attempt(file.path, null, () => { throw new Error("Import exceeds the 1,000-record limit."); }); continue; }
      values.forEach((value, index) => attempt(file.path, index + (format === "csv" ? 2 : 1), () => [normalizeTask(value)]));
    }
  }
  return TaskIntakePreviewSchema.parse({ schemaVersion: "openpond.taskIntakePreview.v1", format, contentHash: contentHash({ format, files }), records, issues: issues.slice(0, 1_000) });
}

function normalizeTask(value: unknown): TaskIntakeRecord {
  const parsed = z.union([taskSchema, structuredTaskSchema]).parse(value);
  const simple = "instruction" in parsed;
  const input = simple ? { instruction: parsed.instruction, ...(parsed.context === undefined ? {} : { context: parsed.context }) } : parsed.input;
  const expected = simple ? parsed.reference === undefined ? null : typeof parsed.reference === "string" ? { text: parsed.reference } : parsed.reference : parsed.expectedOutput ?? null;
  const observedOutput = simple ? null : parsed.observedOutput ?? null;
  // Without an explicit family, identical requests stay together even when
  // their imported labels or reference answers differ.
  const familyKey = parsed.familyKey ?? intakeId("family", input);
  const id = parsed.id ?? intakeId("task", { input, expected, observedOutput });
  return TaskIntakeRecordSchema.parse({ id, familyKey, split: parsed.split ?? "train", kind: observedOutput ? "attempt" : "task", input,
    expected, observedOutput, sourceId: id, sourceHash: contentHash(value), occurredAt: simple ? null : intakeDate(parsed.occurredAt),
    metadata: parsed.labels === undefined ? {} : { importedLabels: parsed.labels, labelOrigin: "unverified_import" }, warnings: [], needsContext: false });
}
