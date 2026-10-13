import { z } from "zod";
import { assertContentHash, contentHash } from "@openpond/harness";
import { GraderSpecSchema } from "@openpond/evals/tasksets";
import { PreparedHarnessExperimentSchema } from "openpond-sdk/experiments";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SignalThresholdsSchema = z.object({
  groupSize: z.number().int().min(2).max(100),
  minimumFamilies: z.number().int().min(2).max(1000),
  minimumInformativeFamilies: z.number().int().min(2).max(1000),
  minimumSpread: z.number().positive().max(1),
  minimumScoredFraction: z.number().positive().max(1),
}).strict().refine(value => value.minimumInformativeFamilies <= value.minimumFamilies,
  "Informative family requirement cannot exceed the minimum family population.");
const PlanBody = z.object({
  schemaVersion: z.literal("openpond.experimentSignalPlan.v1"), createdAt: z.iso.datetime(),
  preparation: PreparedHarnessExperimentSchema, packageHash: Hash,
  graders: z.array(GraderSpecSchema).min(1).max(100),
  tasks: z.array(z.object({ id: z.string(), family: z.string(), taskHash: Hash,
    inputHash: Hash, contextHash: Hash }).strict()).min(1).max(10000),
  thresholds: SignalThresholdsSchema,
}).strict();
export const SignalPlanSchema = PlanBody.extend({ contentHash: Hash }).strict();
export type SignalPlan = z.infer<typeof SignalPlanSchema>;

export function verifySignalPlan(raw: unknown): SignalPlan {
  const plan = SignalPlanSchema.parse(raw);
  const { contentHash: hash, ...body } = plan;
  if (contentHash(body) !== hash) throw new Error("Signal plan content changed.");
  const { request, manifest, graders: pins } = plan.preparation;
  assertContentHash(manifest, "Signal preparation manifest");
  const policy = request.policy;
  // Local native preparation does not require the hosted-only repository metadata projection.
  if (policy.kind !== "hosted_harness" || manifest.execution.kind !== "harness" || manifest.policy.kind !== "model"
    || manifest.runtimeTarget.placement !== "local" || manifest.gradingRole !== "evaluation"
    || contentHash(manifest.profileEvaluation ?? null) !== contentHash(policy.source)
    || contentHash(manifest.execution.harnessRelease) !== contentHash(policy.source.harnessRelease)
    || manifest.packageHash !== policy.packageHash || manifest.policy.configurationHash !== policy.modelConfigurationHash
    || manifest.policy.model.provider !== "openpond" || manifest.policy.model.model !== policy.modelId
    || manifest.policy.model.revision !== null || manifest.policy.model.artifactHash !== (policy.candidate?.contentHash ?? null)
    || manifest.policy.model.tokenizerRevision !== null || manifest.policy.model.chatTemplateHash !== null
    || manifest.tasksetRelease.id !== request.taskset.id || manifest.tasksetRelease.contentHash !== request.taskset.contentHash
    || contentHash(manifest.population) !== contentHash(request.population)
    || manifest.limits.maximumSpendUsd !== plan.preparation.maximumCostUsd
    || (manifest.metadata.profileRepositoryId !== undefined && manifest.metadata.profileRepositoryId !== policy.profileRepositoryId))
    throw new Error("Signal preparation differs from its native local source, package, model, budget or population.");
  for (const member of manifest.population) {
    const identity = policy.source.externalDatasetBinding
      ? [manifest.id, member.taskId, member.seed, member.fixtureId] : [manifest.id, member.taskId, member.seed];
    if (member.receiptId !== `evaluation-${contentHash(identity).slice(0, 32)}`)
      throw new Error("Signal preparation receipt identity changed.");
  }
  if (request.policy.kind !== "hosted_harness" || request.policy.localRuntime || request.policy.packageHash !== plan.packageHash)
    throw new Error("Signal plan requires the exact hosted-chat Harness package.");
  if (new Set(plan.tasks.map(task => task.id)).size !== plan.tasks.length
    || new Set(pins.map(pin => pin.id)).size !== pins.length || plan.graders.length !== pins.length)
    throw new Error("Signal plan contains duplicate or missing tasks/graders.");
  for (const [index, spec] of plan.graders.entries()) {
    const pin = pins[index]!;
    if (pin.id !== spec.id || pin.version !== spec.version || pin.contentHash !== contentHash(spec)
      || spec.hardGate || !spec.rewardEligible || spec.weight <= 0 || spec.taskIds || pin.mappings?.length)
      throw new Error("Signal requires exact positive-weight reward graders, no hard gates, field mappings or task-specific grader subsets.");
  }
  const counts = new Map<string, number>();
  for (const member of request.population) counts.set(member.taskId, (counts.get(member.taskId) ?? 0) + 1);
  if (counts.size !== plan.tasks.length || plan.tasks.some(task => counts.get(task.id) !== plan.thresholds.groupSize))
    throw new Error("Every planned prompt must have exactly groupSize distinct seeded attempts.");
  if (new Set(plan.tasks.map(task => task.family)).size < plan.thresholds.minimumFamilies)
    throw new Error("Signal population has too few independent source families.");
  return plan;
}

/** Freeze this before inference. Hashes detect edits; they do not authenticate a source or prove independence. */
export function createSignalPlan(input: { package: unknown; preparation: unknown; thresholds: unknown; createdAt?: string }): SignalPlan {
  const value = validateTasksetPackage(input.package);
  const preparation = PreparedHarnessExperimentSchema.parse(input.preparation);
  const taskIds = new Set(preparation.request.population.map(member => member.taskId));
  const tasks = value.taskset.tasks.filter(task => taskIds.has(task.id));
  if (tasks.length !== taskIds.size || tasks.some(task => task.split !== "train"))
    throw new Error("Signal probes require existing training tasks; validation/test/frozen holdouts cannot be reused.");
  if (preparation.request.taskset.id !== value.taskset.id || preparation.request.taskset.contentHash !== value.taskset.contentHash)
    throw new Error("Prepared taskset differs from the supplied package.");
  const graders = preparation.graders.map(pin => {
    const spec = value.taskset.graders.find(spec => spec.id === pin.id && contentHash(spec) === pin.contentHash);
    if (!spec) throw new Error(`Selected grader is absent from the exact package: ${pin.id}`);
    return spec;
  });
  const body = PlanBody.parse({ schemaVersion: "openpond.experimentSignalPlan.v1", createdAt: input.createdAt ?? new Date().toISOString(),
    preparation, packageHash: value.contentHash, graders,
    tasks: tasks.map(task => ({ id: task.id, family: task.clusterKey, taskHash: contentHash(task),
      inputHash: contentHash(task.input), contextHash: contentHash(task.policyVisibleContext) })), thresholds: input.thresholds });
  return verifySignalPlan({ ...body, contentHash: contentHash(body) });
}
