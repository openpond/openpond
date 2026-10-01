import { z } from "zod";
import { contentHash, ReleaseHashSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { StandaloneHarnessExperimentSourceSchema, type StandaloneHarnessExperimentSource } from "./harness-experiment-source.js";
import { assertBoundedTaskJson } from "./task-schema.js";

const EvidenceIdSchema = z.string().trim().min(1).max(200);

/** Owner-recorded native turn identities. Raw runtime events remain in the
 * authorized execution store; this receipt retains their exact references. */
export const NativeHarnessExperimentEvidenceSchema = z.object({
  sessionId: EvidenceIdSchema,
  turnId: EvidenceIdSchema,
  source: StandaloneHarnessExperimentSourceSchema,
  admissionHash: ReleaseHashSchema,
  modelConfigurationHash: ReleaseHashSchema,
  traceHash: ReleaseHashSchema,
  runtimeEventRefs: z.array(EvidenceIdSchema).max(10_000),
  startedAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema,
  outputHash: ReleaseHashSchema,
  partialOutputAvailable: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.runtimeEventRefs).size !== value.runtimeEventRefs.length)
    context.addIssue({ code: "custom", path: ["runtimeEventRefs"], message: "Native event references must be unique." });
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt))
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Native completion precedes its start." });
});
export type NativeHarnessExperimentEvidence = z.infer<typeof NativeHarnessExperimentEvidenceSchema>;

/** This qualified standalone contract is for text Datasets. A prepared task
 * needs its independently qualified environment receipt, not a null snapshot
 * presented as evidence that its environment ran. */
export const NativeHarnessExperimentAttemptContentSchema = z.object({
  schemaVersion: z.literal("openpond.nativeHarnessExperimentAttempt.v1"),
  taskId: z.string().min(1).max(500),
  status: z.enum(["completed", "cancelled", "timed_out", "policy_failure"]),
  output: z.string().max(8_388_608).nullable(),
  error: z.string().max(2_000).nullable(),
  messages: z.array(z.unknown()).max(4_002),
  collected: z.boolean(),
  environmentCleanupComplete: z.literal(true),
  snapshot: z.null(),
  native: NativeHarnessExperimentEvidenceSchema,
}).strict().superRefine((value, context) => {
  const completed = value.status === "completed";
  if (completed !== value.collected || completed !== (value.output !== null)
    || completed !== (value.error === null))
    context.addIssue({ code: "custom", message: "Native status, output, collection and error must agree." });
  if (completed && (value.native.partialOutputAvailable || value.native.outputHash !== contentHash(value.output)))
    context.addIssue({ code: "custom", path: ["native", "outputHash"], message: "Native output differs from its retained evidence." });
});
export const NativeHarnessExperimentAttemptSchema = NativeHarnessExperimentAttemptContentSchema
  .extend({ contentHash: ReleaseHashSchema }).strict();
export type NativeHarnessExperimentAttempt = z.infer<typeof NativeHarnessExperimentAttemptSchema>;

export function createNativeHarnessExperimentAttempt(
  input: z.input<typeof NativeHarnessExperimentAttemptContentSchema>,
): NativeHarnessExperimentAttempt {
  assertBoundedTaskJson(input, 16_777_216);
  const content = NativeHarnessExperimentAttemptContentSchema.parse(input);
  return NativeHarnessExperimentAttemptSchema.parse({ ...content, contentHash: contentHash(content) });
}

/** Artifact access and trace ownership are enforced by the host. Verification
 * binds the artifact bytes to that host's independently admitted case. */
export function verifyNativeHarnessExperimentAttempt(value: unknown, context: {
  taskId: string;
  source: StandaloneHarnessExperimentSource;
  admissionHash: string;
  modelConfigurationHash: string;
  traceHash: string;
}): NativeHarnessExperimentAttempt {
  assertBoundedTaskJson(value, 16_777_216);
  const result = NativeHarnessExperimentAttemptSchema.parse(value);
  const { contentHash: hash, ...content } = result;
  if (contentHash(content) !== hash || result.taskId !== context.taskId
    || contentHash(result.native.source) !== contentHash(StandaloneHarnessExperimentSourceSchema.parse(context.source))
    || result.native.admissionHash !== context.admissionHash
    || result.native.modelConfigurationHash !== context.modelConfigurationHash
    || result.native.traceHash !== context.traceHash)
    throw new Error("Native Harness attempt differs from its admitted case or retained trace.");
  return result;
}
