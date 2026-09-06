import { z } from "zod";
import { TasksetReleaseSchema, assertTasksetRelease } from "@openpond/evals/tasksets";
import { LearningTextAssetSchema, TaskDefinitionSchema, learningRef, sameLearningRef, sealLearningContent } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { assertBoundedTaskJson, validateTaskValue } from "@openpond/evals/task-schema";

import { ModelProjectBaseModelSchema, ModelProjectTrainingMethodSchema, ModelProjectVersionedRefSchema } from "./model-projects.js";
import { canonicalSha256 } from "./protocol.js";

const IdSchema = z.string().trim().min(1).max(500);
const RefSchema = ModelProjectVersionedRefSchema;

/** Catalog records contain references and previews, never the private task rows. */
export const ModelStarterContentSchema = z.object({
  schemaVersion: z.literal("openpond.modelStarter.v1"),
  id: IdSchema,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  category: z.enum(["extraction", "support", "operations", "knowledge", "coding", "writing", "classification"]),
  taskset: RefSchema,
  taskDefinition: RefSchema,
  rewardBinding: RefSchema,
  rewards: z.array(RefSchema).min(1).max(100),
  assets: z.array(RefSchema).max(1_000),
  previewTaskIds: z.array(IdSchema).min(1).max(8),
  startingModel: ModelProjectBaseModelSchema,
  supportedMethods: z.array(ModelProjectTrainingMethodSchema).min(1).max(8),
  defaultMethod: ModelProjectTrainingMethodSchema,
  provenance: z.object({ author: z.string().min(1).max(200), license: z.string().min(1).max(200), sourceDescription: z.string().min(1).max(2_000) }).strict(),
  // These are references to real results. Package publication does not create
  // evidence, qualify a starter, or enable continuous learning.
  evidence: z.object({ verifierFixtures: RefSchema.nullable(), baseline: RefSchema.nullable(), training: RefSchema.nullable(), evaluation: RefSchema.nullable() }).strict(),
}).strict().superRefine((starter, context) => {
  if (!starter.supportedMethods.includes(starter.defaultMethod)) context.addIssue({ code: "custom", path: ["defaultMethod"], message: "The default method must be supported by the package." });
  for (const field of ["rewards", "assets"] as const) {
    if (new Set(starter[field].map(ref => ref.id)).size !== starter[field].length) context.addIssue({ code: "custom", path: [field], message: "Dependency identities must be unique." });
  }
  if (new Set(starter.previewTaskIds).size !== starter.previewTaskIds.length) context.addIssue({ code: "custom", path: ["previewTaskIds"], message: "Preview tasks must be unique." });
});
export const ModelStarterSchema = ModelStarterContentSchema.safeExtend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type ModelStarter = z.infer<typeof ModelStarterSchema>;

/** A resolved small package, obtained separately from catalog discovery.
 * Large Tasksets remain manifest/shard resources; they are not list payloads. */
export const ResolvedModelStarterSchema = z.object({
  starter: ModelStarterSchema,
  taskset: TasksetReleaseSchema,
  taskDefinition: TaskDefinitionSchema,
  rewardBinding: RewardBindingSchema,
  rewards: z.array(RewardReleaseSchema).min(1).max(100),
  assets: z.array(LearningTextAssetSchema).max(1_000),
}).strict();
export type ResolvedModelStarter = z.infer<typeof ResolvedModelStarterSchema>;

/** Final creation intent. The server resolves package bytes from its catalog;
 * callers cannot supply executable resources or qualification receipts here. */
export const ModelStarterCreationIntentSchema = z.object({
  profileId: IdSchema,
  modelId: IdSchema,
  name: z.string().trim().min(1).max(200),
  starter: RefSchema,
  startingModel: ModelProjectBaseModelSchema,
  method: ModelProjectTrainingMethodSchema,
}).strict();
export const ModelStarterCreationRequestSchema = ModelStarterCreationIntentSchema.extend({
  schemaVersion: z.literal("openpond.modelStarterCreation.v1"),
  operationId: IdSchema,
}).strict();
export type ModelStarterCreationRequest = z.infer<typeof ModelStarterCreationRequestSchema>;

export function parseModelStarterCreationRequest(value: unknown): ModelStarterCreationRequest {
  assertBoundedTaskJson(value, 64 * 1024);
  return ModelStarterCreationRequestSchema.parse(value);
}

/** Prepare once on final confirmation and retain across uncertain transport
 * outcomes. The server must bind operationId to the complete original intent
 * and atomically commit resources, model configuration and the retry receipt. */
export async function createModelStarterCreationRequest(
  value: z.input<typeof ModelStarterCreationIntentSchema>,
): Promise<ModelStarterCreationRequest> {
  assertBoundedTaskJson(value, 64 * 1024);
  const intent = ModelStarterCreationIntentSchema.parse(value);
  return parseModelStarterCreationRequest({
    ...intent,
    schemaVersion: "openpond.modelStarterCreation.v1",
    operationId: `model-starter:${await canonicalSha256(intent)}`,
  });
}

/** Scope authorization belongs to the API. This validates the final intent
 * against the exact trusted package before any user resources are written. */
export function validateModelStarterCreation(value: unknown, packageValue: unknown) {
  const request = parseModelStarterCreationRequest(value);
  const resolved = validateResolvedModelStarter(packageValue);
  if (!sameLearningRef(request.starter, learningRef(resolved.starter))) throw new Error("Starter creation references a different package revision.");
  if (!resolved.starter.supportedMethods.includes(request.method)) throw new Error("The selected training method is not supported by this starter.");
  return { request, resolved };
}

/** Explicit projection keeps frozen examples, expected outputs, privileged
 * context and verifier source out of read-only model-facing previews. */
export function previewModelStarter(value: unknown) {
  const { starter, taskset, taskDefinition } = validateResolvedModelStarter(value);
  return {
    starter,
    inputSchema: taskDefinition.inputSchema,
    outputSchema: taskDefinition.outputSchema,
    tasks: starter.previewTaskIds.map(id => {
      const task = taskset.tasks.find(task => task.id === id)!;
      return { id: task.id, input: task.input, policyVisibleContext: task.policyVisibleContext };
    }),
    counts: {
      train: taskset.tasks.filter(task => task.split === "train").length,
      validation: taskset.tasks.filter(task => task.split === "validation").length,
      frozenEvaluation: taskset.tasks.filter(task => task.split === "frozen_eval").length,
    },
  };
}

/** Verify the dependency graph before creating user-owned configuration.
 * A matching outer hash alone cannot authorize substituted private graders. */
export function validateResolvedModelStarter(value: unknown): ResolvedModelStarter {
  assertBoundedTaskJson(value, 16 * 1024 * 1024);
  const resolved = ResolvedModelStarterSchema.parse(value);
  const { starter, taskset, taskDefinition, rewardBinding, rewards, assets } = resolved;
  const resources = [starter, taskset, taskDefinition, rewardBinding, ...rewards, ...assets];
  for (const resource of resources) {
    const { contentHash, ...content } = resource;
    if (sealLearningContent(content).contentHash !== contentHash) throw new Error(`Starter resource integrity failed: ${resource.id}.`);
  }
  assertTasksetRelease(taskset);
  function exact(expected: z.infer<typeof RefSchema>, resource: { id: string; revision: number; contentHash: string }) {
    if (!sameLearningRef(expected, learningRef(resource))) throw new Error(`Starter dependency mismatch: ${expected.id}.`);
  }
  exact(starter.taskset, taskset);
  exact(starter.taskDefinition, taskDefinition);
  exact(starter.rewardBinding, rewardBinding);
  exact(taskDefinition.rewardBinding, rewardBinding);
  if (rewardBinding.recipeRef) throw new Error("Starter binding recipes must be resolved into a standalone binding before publication.");
  const { policy, environment, environmentRelease, tools, capabilities, verifierSetRelease } = taskset;
  const execution = { policy, environment, ...(environmentRelease ? { environmentRelease } : {}), tools, capabilities, ...(verifierSetRelease ? { verifierSetRelease } : {}) };
  if (sealLearningContent(execution).contentHash !== sealLearningContent(taskDefinition.execution).contentHash) throw new Error("Starter execution context differs from its task format.");
  if (sealLearningContent({ graders: taskset.graders }).contentHash !== sealLearningContent({ graders: compileBoundGraders(rewardBinding, rewards) }).contentHash) throw new Error("Starter executable graders differ from its Reward binding.");
  for (const [references, values] of [[starter.rewards, rewards], [starter.assets, assets]] as const) {
    if (references.length !== values.length || new Set(values.map(resource => resource.id)).size !== values.length) throw new Error("Starter dependency inventory mismatch.");
    for (const ref of references) {
      const resource = values.find(value => value.id === ref.id);
      if (!resource) throw new Error(`Starter dependency is missing: ${ref.id}.`);
      exact(ref, resource);
    }
  }
  for (const source of rewardBinding.sources) {
    const reward = rewards.find(reward => reward.id === source.reward.id);
    if (!reward) throw new Error(`Starter Reward is missing: ${source.reward.id}.`);
    exact(source.reward, reward);
  }
  for (const reward of rewards) {
    const implementation = reward.implementation;
    const references = [...reward.assets,
      ...("verifierRef" in implementation ? [implementation.verifierRef] : []),
      ...("rubricRef" in implementation ? [implementation.rubricRef] : []),
      ...("inputContract" in implementation ? [implementation.inputContract] : []),
    ];
    for (const ref of references) {
      const asset = assets.find(asset => asset.id === ref.id);
      if (!asset || sealLearningContent(asset.asset).contentHash !== sealLearningContent(ref).contentHash) throw new Error(`Starter Reward source is missing or changed: ${ref.id}.`);
      if (ref.visibility === "policy") throw new Error(`Starter Reward source must remain private to its evaluator: ${ref.id}.`);
    }
  }
  if (new Set(taskset.tasks.map(task => task.id)).size !== taskset.tasks.length) throw new Error("Starter task identities must be unique.");
  const inputSplits = new Map<string, string>();
  for (const task of taskset.tasks) {
    if (task.policyVisibleContext.instructions !== taskDefinition.instructions) throw new Error(`Starter task does not carry its declared model instructions: ${task.id}.`);
    const inputHash = sealLearningContent({ input: task.input, context: task.policyVisibleContext }).contentHash;
    const priorSplit = inputSplits.get(inputHash);
    if (priorSplit && priorSplit !== task.split) throw new Error("Starter policy input appears in multiple splits.");
    inputSplits.set(inputHash, task.split);
    if (!validateTaskValue(taskDefinition.inputSchema, task.input).valid) throw new Error(`Starter task input does not match its format: ${task.id}.`);
    if (task.expectedOutput !== null && !validateTaskValue(taskDefinition.outputSchema, task.expectedOutput).valid) throw new Error(`Starter expected output does not match its format: ${task.id}.`);
  }
  for (const id of starter.previewTaskIds) {
    const task = taskset.tasks.find(task => task.id === id);
    if (!task || task.split === "frozen_eval") throw new Error(`Starter preview task is unavailable: ${id}.`);
  }
  return resolved;
}
