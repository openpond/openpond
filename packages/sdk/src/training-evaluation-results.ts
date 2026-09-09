import { z } from "zod";
import { ModelProjectImmutableRefSchema, ModelProjectVersionedRefSchema } from "./model-projects.js";
import {
  OpenPondProtocolError,
  TRAINING_API_RESPONSE_MAX_BYTES,
  assertCanonicalPayloadSize,
  canonicalSha256,
} from "./protocol.js";

const IdSchema = z.string().trim().min(1).max(500);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Reviewer-facing evidence only: never a worker response or training sample. */
export const TrainingEvaluationTaskResultSchema = z.object({
  taskId: IdSchema,
  taskSha256: HashSchema,
  resultSha256: HashSchema,
  input: z.object({
    instruction: z.string().max(1_000_000),
    context: z.record(z.string(), z.unknown()),
  }).strict(),
  output: z.string().max(1_000_000),
  outputSha256: HashSchema,
  score: z.number().finite().min(0).max(1),
  evidence: z.object({
    kind: z.enum(["worker_command", "hosted_trace", "local_trace"]),
    id: IdSchema,
  }).strict(),
}).strict();

/** Supplements an existing evaluation; does not replace its terminal receipt. */
export const TrainingEvaluationTaskPageSchema = z.object({
  schemaVersion: z.literal("openpond.trainingEvaluationTaskPage.v1"),
  jobId: IdSchema,
  teamId: IdSchema,
  evaluation: ModelProjectImmutableRefSchema,
  kind: z.enum(["baseline", "candidate"]),
  policyVersion: z.number().int().nonnegative(),
  taskset: ModelProjectVersionedRefSchema,
  panelSha256: HashSchema,
  offset: z.number().int().nonnegative(),
  total: z.number().int().min(1).max(10_000),
  tasks: z.array(TrainingEvaluationTaskResultSchema).min(1).max(100),
  nextCursor: z.string().regex(/^[1-9]\d*$/).nullable(),
  contentHash: HashSchema,
}).strict().superRefine((page, context) => {
  const end = page.offset + page.tasks.length;
  const expectedCursor = end < page.total ? String(end) : null;
  if (end > page.total || page.nextCursor !== expectedCursor) {
    context.addIssue({ code: "custom", path: ["nextCursor"], message: "Evaluation pagination must cover consecutive task positions." });
  }
  if (new Set(page.tasks.map((task) => task.taskId)).size !== page.tasks.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Evaluation task identities must be unique." });
  }
});

export type TrainingEvaluationTaskResult = z.infer<typeof TrainingEvaluationTaskResultSchema>;
export type TrainingEvaluationTaskPage = z.infer<typeof TrainingEvaluationTaskPageSchema>;

export async function trainingEvaluationTaskPageHash(
  value: Omit<TrainingEvaluationTaskPage, "contentHash"> | TrainingEvaluationTaskPage,
): Promise<string> {
  const { contentHash: _contentHash, ...content } = value as TrainingEvaluationTaskPage;
  return canonicalSha256(content);
}

export async function parseAndVerifyTrainingEvaluationTaskPage(
  value: unknown,
  expected: {
    jobId: string;
    evaluation: { id: string; contentHash: string };
    offset?: number;
    teamId?: string;
  },
): Promise<TrainingEvaluationTaskPage> {
  assertCanonicalPayloadSize(value, TRAINING_API_RESPONSE_MAX_BYTES, "Training evaluation task page");
  const page = TrainingEvaluationTaskPageSchema.parse(value);
  const reference = ModelProjectImmutableRefSchema.parse(expected.evaluation);
  if (page.jobId !== IdSchema.parse(expected.jobId)
    || page.evaluation.id !== reference.id
    || page.evaluation.contentHash !== reference.contentHash
    || page.offset !== (expected.offset ?? 0)
    || (expected.teamId !== undefined && page.teamId !== IdSchema.parse(expected.teamId))) {
    throw new OpenPondProtocolError("evaluation_page_identity_mismatch", "Evaluation results differ from the requested Job, evaluation, or page.");
  }
  if (await trainingEvaluationTaskPageHash(page) !== page.contentHash) {
    throw new OpenPondProtocolError("evaluation_page_hash_mismatch", "Evaluation task page content hash did not match.");
  }
  for (const task of page.tasks) {
    if (await canonicalSha256(task.output) !== task.outputSha256) {
      throw new OpenPondProtocolError("evaluation_output_hash_mismatch", "A retained evaluation output hash did not match.");
    }
  }
  return page;
}
