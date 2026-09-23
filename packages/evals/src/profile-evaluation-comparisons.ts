import { z } from "zod";

import {
  ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema,
  ReleaseTimestampSchema, assertContentHash, contentHash,
} from "@openpond/harness";
import { assertTasksetMetricResult, type TasksetMetricResult } from "./metric-policy.js";
import { ProfileEvaluationRunSourceSchema } from "./profile-evaluations.js";
import { TasksetRunManifestSchema, type TasksetRunManifest } from "./taskset-run-contract.js";

export const ProfileEvaluationComparisonContentSchema = z.object({
  schemaVersion: z.literal("openpond.profileEvaluationComparison.v1"),
  id: ReleaseIdSchema,
  tasksetRelease: ImmutableReleaseRefSchema,
  populationHash: ReleaseHashSchema,
  environmentHash: ReleaseHashSchema,
  metricPolicyHash: ReleaseHashSchema,
  limitsHash: ReleaseHashSchema,
  members: z.array(z.object({
    runManifest: ImmutableReleaseRefSchema,
    metricResultHash: ReleaseHashSchema,
    source: ProfileEvaluationRunSourceSchema,
    policy: TasksetRunManifestSchema.shape.policy,
    score: z.number().min(0).max(1).nullable(),
  }).strict()).min(2).max(100),
  createdAt: ReleaseTimestampSchema,
}).strict();
export const ProfileEvaluationComparisonSchema = ProfileEvaluationComparisonContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();
export type ProfileEvaluationComparison = z.infer<typeof ProfileEvaluationComparisonSchema>;

/** Comparison membership is immutable and refers to existing run evidence.
 * The same Taskset, population, environment, metric and limits are required;
 * model and released Profile source may vary independently. */
export function createProfileEvaluationComparison(input: {
  id: string;
  members: Array<{ manifest: TasksetRunManifest; result: TasksetMetricResult }>;
  createdAt: string;
}): ProfileEvaluationComparison {
  if (input.members.length < 2) throw new Error("A comparison requires at least two runs.");
  const parsed = input.members.map(({ manifest, result }) => {
    TasksetRunManifestSchema.parse(manifest);
    assertContentHash(manifest, "Taskset run manifest");
    assertTasksetMetricResult(result);
    if (!manifest.profileEvaluation || manifest.execution.kind !== "harness") {
      throw new Error("Profile comparison requires released Profile evaluation runs.");
    }
    if (result.runManifest.id !== manifest.id || result.runManifest.contentHash !== manifest.contentHash
      || result.tasksetRelease.id !== manifest.tasksetRelease.id
      || result.tasksetRelease.contentHash !== manifest.tasksetRelease.contentHash
      || result.policyHash !== contentHash(manifest.metricPolicy)) {
      throw new Error("Profile comparison metric differs from its run manifest.");
    }
    return { manifest, result, source: manifest.profileEvaluation };
  });
  const baseline = parsed[0]!;
  const populationHash = contentHash(baseline.manifest.population.map(({ taskId, seed, fixtureId }) => ({ taskId, seed, fixtureId })));
  const metricPolicyHash = contentHash(baseline.manifest.metricPolicy);
  const limitsHash = contentHash(baseline.manifest.limits);
  const ids = new Set<string>();
  for (const member of parsed) {
    if (ids.has(member.manifest.id)) throw new Error("Profile comparison repeats a run.");
    ids.add(member.manifest.id);
    if (member.manifest.tasksetRelease.id !== baseline.manifest.tasksetRelease.id
      || member.manifest.tasksetRelease.contentHash !== baseline.manifest.tasksetRelease.contentHash
      || contentHash(member.manifest.population.map(({ taskId, seed, fixtureId }) => ({ taskId, seed, fixtureId }))) !== populationHash
      || member.source.environmentHash !== baseline.source.environmentHash
      || contentHash(member.manifest.metricPolicy) !== metricPolicyHash
      || contentHash(member.manifest.limits) !== limitsHash
      || member.manifest.runtimeTarget.adapterId !== baseline.manifest.runtimeTarget.adapterId
      || member.manifest.runtimeTarget.placement !== baseline.manifest.runtimeTarget.placement
      || member.manifest.runtimeTarget.runtimeVersion !== baseline.manifest.runtimeTarget.runtimeVersion) {
      throw new Error("Profile comparison runs differ in frozen tasks, environment, grading, limits, or runtime.");
    }
  }
  const content = ProfileEvaluationComparisonContentSchema.parse({
    schemaVersion: "openpond.profileEvaluationComparison.v1",
    id: input.id,
    tasksetRelease: baseline.manifest.tasksetRelease,
    populationHash,
    environmentHash: baseline.source.environmentHash,
    metricPolicyHash,
    limitsHash,
    members: parsed.map(({ manifest, result, source }) => ({
      runManifest: { id: manifest.id, contentHash: manifest.contentHash },
      metricResultHash: result.contentHash,
      source,
      policy: manifest.policy,
      score: result.value,
    })),
    createdAt: input.createdAt,
  });
  return ProfileEvaluationComparisonSchema.parse({ ...content, contentHash: contentHash(content) });
}
