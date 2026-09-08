import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { canonicalSha256 } from "./protocol.js";

export const TRAINING_EVALUATION_SOURCE_PATH = "evaluation-source.json";

const TaskIdentitySchema = z.object({
  id: z.string().trim().min(1),
  clusterKey: z.string().trim().min(1),
  split: z.enum(["train", "validation", "frozen_eval"]),
}).passthrough();

/** Evaluator-only payload. The enclosing resolved bundle pins every byte. */
export const TrainingEvaluationSourceSchema = z.object({
  schemaVersion: z.literal("openpond.trainingEvaluationSource.v1"),
  taskset: ModelProjectVersionedRefSchema,
  tasks: z.array(TaskIdentitySchema).min(1).max(10_000),
  assets: z.array(z.object({
    path: z.string().trim().min(1).max(2_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    encoding: z.literal("base64"),
    content: z.string().max(32 * 1024 * 1024),
  }).strict()).max(10_000),
}).strict().superRefine((source, context) => {
  const ids = new Set<string>();
  source.tasks.forEach((task, index) => {
    if (task.split === "train") context.addIssue({ code: "custom", path: ["tasks", index, "split"], message: "Evaluation sources require held-out tasks." });
    if (ids.has(task.id)) context.addIssue({ code: "custom", path: ["tasks", index, "id"], message: "Evaluation task identities must be unique." });
    ids.add(task.id);
  });
});

export type TrainingEvaluationSource = z.infer<typeof TrainingEvaluationSourceSchema>;

export function assertTrainingEvaluationIsolation(trainingTasks: unknown, evaluationTasks: unknown): void {
  const training = z.array(TaskIdentitySchema).min(1).max(10_000).parse(trainingTasks);
  const evaluation = z.array(TaskIdentitySchema).min(1).max(10_000).parse(evaluationTasks);
  const trainIds = new Set<string>();
  const trainFamilies = new Set<string>();
  for (const task of training) {
    if (task.split !== "train") throw new Error("The training population contains a held-out task.");
    if (trainIds.has(task.id)) throw new Error("Training task identities must be unique.");
    trainIds.add(task.id);
    trainFamilies.add(task.clusterKey);
  }
  const evaluationIds = new Set<string>();
  for (const task of evaluation) {
    if (task.split === "train") throw new Error("The evaluation population contains a training task.");
    if (evaluationIds.has(task.id)) throw new Error("Evaluation task identities must be unique.");
    if (trainIds.has(task.id) || trainFamilies.has(task.clusterKey)) {
      throw new Error("Training and evaluation tasks or families overlap.");
    }
    evaluationIds.add(task.id);
  }
}

export async function trainingEvaluationSourceRef(input: unknown) {
  const source = TrainingEvaluationSourceSchema.parse(input);
  const hash = await canonicalSha256(source);
  return { taskset: source.taskset, dataset: { id: `training-evaluation-${hash.slice(0, 32)}`, contentHash: hash } };
}
