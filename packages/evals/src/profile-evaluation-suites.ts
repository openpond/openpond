import { z } from "zod";

import {
  ImmutableReleaseRefSchema, ReleaseHashSchema, ReleaseIdSchema,
  ReleaseTimestampSchema, assertContentHash, contentHash,
} from "@openpond/harness";
import { ProfileEvaluationCatalogSchema, type ProfileEvaluationCatalog } from "./profile-evaluations.js";
import { TasksetRunManifestSchema, type TasksetRunManifest } from "./taskset-run-contract.js";

export const ProfileEvaluationSuiteRunContentSchema = z.object({
  schemaVersion: z.literal("openpond.profileEvaluationSuiteRun.v1"),
  id: ReleaseIdSchema,
  suiteId: ReleaseIdSchema,
  suiteHash: ReleaseHashSchema,
  catalogHash: ReleaseHashSchema,
  profileId: ReleaseIdSchema,
  sourceRevision: z.string().trim().min(1).max(240),
  harnessRelease: ImmutableReleaseRefSchema,
  members: z.array(z.object({
    definitionId: ReleaseIdSchema,
    runManifest: ImmutableReleaseRefSchema,
    runHash: ReleaseHashSchema,
    passed: z.boolean(),
    score: z.number().min(0).max(1).nullable(),
  }).strict()).min(1).max(1_000),
  passed: z.boolean(),
  createdAt: ReleaseTimestampSchema,
  completedAt: ReleaseTimestampSchema,
}).strict();
export const ProfileEvaluationSuiteRunSchema = ProfileEvaluationSuiteRunContentSchema.extend({
  contentHash: ReleaseHashSchema,
}).strict();
export type ProfileEvaluationSuiteRun = z.infer<typeof ProfileEvaluationSuiteRunSchema>;

/** Suite membership preserves each definition's own Taskset and metric. A
 * suite passes only when every declared check passes; unlike scores are never
 * averaged. */
export function createProfileEvaluationSuiteRun(input: {
  id: string;
  suiteId: string;
  catalog: ProfileEvaluationCatalog;
  members: Array<{
    definitionId: string;
    manifest: TasksetRunManifest;
    runHash: string;
    passed: boolean;
    score: number | null;
  }>;
  createdAt: string;
  completedAt: string;
}): ProfileEvaluationSuiteRun {
  const catalog = ProfileEvaluationCatalogSchema.parse(input.catalog);
  const suite = catalog.suites.find((candidate) => candidate.id === input.suiteId);
  if (!suite) throw new Error(`Profile evaluation suite ${input.suiteId} is absent from its catalog.`);
  if (input.members.length !== suite.definitionIds.length) {
    throw new Error("Profile evaluation suite has an incomplete run population.");
  }
  const parsed = input.members.map((member, index) => {
    const definitionId = suite.definitionIds[index];
    const definition = catalog.definitions.find((candidate) => candidate.id === definitionId);
    if (!definition || member.definitionId !== definitionId) {
      throw new Error("Profile evaluation suite members differ from declared definition order.");
    }
    const manifest = TasksetRunManifestSchema.parse(member.manifest);
    assertContentHash(manifest, "Profile evaluation suite member manifest");
    const source = manifest.profileEvaluation;
    if (!source || manifest.execution.kind !== "harness"
      || source.definitionId !== definitionId
      || source.definitionHash !== contentHash(definition)
      || contentHash(source.target) !== contentHash(definition.target)
      || source.catalogHash !== contentHash(catalog)
      || manifest.tasksetRelease.id !== definition.tasksetRelease.id
      || manifest.tasksetRelease.contentHash !== definition.tasksetRelease.contentHash) {
      throw new Error("Profile evaluation suite member differs from its released definition.");
    }
    return { ...member, manifest, source };
  });
  const first = parsed[0]!.source;
  const firstPolicy = parsed[0]!.manifest.policy;
  if (firstPolicy.kind !== "model") throw new Error("Profile evaluation suite requires model runs.");
  for (const member of parsed) {
    if (member.source.profileId !== first.profileId
      || member.source.sourceRevision !== first.sourceRevision
      || member.source.harnessRelease.id !== first.harnessRelease.id
      || member.source.harnessRelease.contentHash !== first.harnessRelease.contentHash) {
      throw new Error("Profile evaluation suite members use different Profile releases.");
    }
    const policy = member.manifest.policy;
    if (policy.kind !== "model" || contentHash(policy) !== contentHash(firstPolicy)) {
      throw new Error("Profile evaluation suite members use different model configurations.");
    }
  }
  const content = ProfileEvaluationSuiteRunContentSchema.parse({
    schemaVersion: "openpond.profileEvaluationSuiteRun.v1",
    id: input.id,
    suiteId: suite.id,
    suiteHash: contentHash(suite),
    catalogHash: contentHash(catalog),
    profileId: first.profileId,
    sourceRevision: first.sourceRevision,
    harnessRelease: first.harnessRelease,
    members: parsed.map((member) => ({
      definitionId: member.definitionId,
      runManifest: { id: member.manifest.id, contentHash: member.manifest.contentHash },
      runHash: member.runHash,
      passed: member.passed,
      score: member.score,
    })),
    passed: parsed.every((member) => member.passed),
    createdAt: input.createdAt,
    completedAt: input.completedAt,
  });
  return ProfileEvaluationSuiteRunSchema.parse({ ...content, contentHash: contentHash(content) });
}
