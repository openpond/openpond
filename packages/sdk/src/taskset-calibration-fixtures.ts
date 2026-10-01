import { z } from "zod";
import { contentHash, ImmutableAssetRefSchema, sha256, type ImmutableAssetRef } from "@openpond/harness";
import { compileBoundGraders, createRewardBinding, RewardReleaseRefSchema } from "@openpond/evals/rewards";
import { TaskRecordSchema, type GraderSpec } from "@openpond/evals/tasksets";
import { learningRef, LearningRevisionRefSchema, RewardFixtureSchema, verifyRewardCalibrationClosure,
  rewardCalibrationClosureAsset, MAX_REWARD_CALIBRATION_CLOSURE_BYTES, type RewardCalibrationClosure } from "@openpond/evals/learning/reward-calibration-closure";
import { GraderFixtureSchema, type GraderFixture } from "./taskset-draft-core.js";
import type { TasksetPackage } from "./taskset-package-contracts.js";
import { decodeTasksetPackageFile } from "./taskset-package-files.js";

const ProjectionSchema = z.object({
  schemaVersion: z.literal("openpond.connectedRewardCalibrationProjection.v1"),
  sourceReward: RewardReleaseRefSchema,
  fixtureSet: ImmutableAssetRefSchema,
  calibrationCheck: LearningRevisionRefSchema,
  fixture: RewardFixtureSchema,
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkResultHash: z.string().regex(/^[a-f0-9]{64}$/),
  independentCalibrationTask: z.literal(true),
  closureRef: ImmutableAssetRefSchema,
  graderId: z.string().min(1).max(240).optional(),
}).strict();

function authoredFixtures(value: TasksetPackage): GraderFixture[] {
  const authoring = value.taskset.metadata.ordinaryAuthoring ?? value.taskset.metadata.starterAuthoring;
  return z.object({ graderFixtures: GraderFixtureSchema.array().max(100_000).default([]) }).passthrough().parse(authoring ?? {}).graderFixtures;
}

function isIndependent(fixture: GraderFixture): boolean {
  const projection = fixture.metadata.rewardCalibration;
  return projection !== undefined;
}

/** No package-contract runtime import: this validator is called by ordinary
 * package admission before any target sees attachments or environment files. */
export function assertTasksetCalibrationClosures(value: TasksetPackage): void {
  for (const fixture of authoredFixtures(value)) {
    const projection = fixture.metadata.rewardCalibration;
    // Opaque old metadata is retained history, not qualified calibration. An
    // explicit closure declaration is an immutable asset admission boundary.
    if (projection && typeof projection === "object" && Object.hasOwn(projection, "closureRef"))
      resolveIndependent(value, fixture);
  }
  // Unreferenced closures also retain their strict private classification.
  for (const file of value.files) if (file.asset.mediaType === "application/vnd.openpond.reward-calibration-closure+json")
    readPrivateClosure(value, file.asset);
}

export function resolveTasksetCalibrationFixture(value: TasksetPackage, fixtureId: string) {
  const { contentHash: packageHash, ...packageContent } = value;
  if (contentHash(packageContent) !== packageHash) fail("calibration_package_changed");
  const fixtures = authoredFixtures(value).filter(fixture => fixture.id === fixtureId);
  if (fixtures.length !== 1) fail("calibration_fixture_not_unique");
  const fixture = fixtures[0]!;
  if (!isIndependent(fixture)) fail("calibration_fixture_not_independent");
  return resolveIndependent(value, fixture);
}
export type ResolvedTasksetCalibrationFixture = ReturnType<typeof resolveTasksetCalibrationFixture>;

function resolveIndependent(value: TasksetPackage, authored: GraderFixture) {
  const projection = ProjectionSchema.parse(authored.metadata.rewardCalibration);
  const closure = readPrivateClosure(value, projection.closureRef);
  if (contentHash(projection.sourceReward) !== contentHash(learningRef(closure.reward))
    || contentHash(projection.fixtureSet) !== contentHash(closure.reward.fixtureSetRef)
    || projection.calibrationCheck.id !== closure.check.id || projection.calibrationCheck.revision !== closure.check.revision
    || projection.calibrationCheck.contentHash !== contentHash(closure.check)) fail("calibration_source_changed");
  const fixture = projection.fixture;
  const id = `calibration-${contentHash([projection.sourceReward, fixture.id])}`;
  if (authored.id !== id || authored.taskId !== id || value.taskset.tasks.some(task => task.id === id)
    || projection.fixtureHash !== contentHash(fixture) || contentHash(authored.output) !== contentHash(fixture.output)
    || authored.infrastructureError !== fixture.infrastructureError) fail("calibration_fixture_changed");
  const checks = closure.check.results.filter(result => result.fixture.id === fixture.id && result.fixture.contentHash === projection.fixtureHash);
  if (checks.length !== 1 || contentHash(checks[0]) !== projection.checkResultHash) fail("calibration_result_changed");
  const expected = fixture.expected;
  if (expected.status !== "scored" || typeof expected.passed !== "boolean" || authored.expectedPassed !== expected.passed
    || authored.label !== (expected.passed ? "positive" : "negative")) fail("calibration_expectation_unsupported");
  const graderId = projection.graderId ?? projection.sourceReward.id;
  const graders = value.taskset.graders.filter(grader => grader.id === graderId);
  const grader = graders[0];
  if (graders.length !== 1 || !grader) fail("calibration_grader_not_unique");
  if (authored.expectedRewardEligible !== grader.rewardEligible) fail("calibration_reward_expectation_changed");
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: `calibration-${closure.contentHash}`, revision: 1,
    sources: [{ graderId, reward: projection.sourceReward, role: "evaluation", normalization: { kind: "identity" }, weight: grader.weight,
      required: true, hardGate: grader.hardGate, privileged: grader.privileged, fixtureRefs: [] }],
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [closure.reward]);
  const canonical = compileBoundGraders(binding, [closure.reward])[0]!;
  const implementation = (spec: GraderSpec) => {
    const { rewardEligible: _eligible, ...rest } = spec;
    return rest.kind === "model_judge" ? { ...rest, temperature: rest.temperature ?? 0 } : rest;
  };
  if (contentHash(implementation(grader)) !== contentHash(implementation(canonical))) fail("calibration_grader_changed");
  if (grader.kind === "model_judge") assertJudgeFixtureMembership(value, grader, projection, closure);
  return {
    kind: "independent_reward_calibration" as const,
    fixtureId: id,
    task: TaskRecordSchema.parse({ id, clusterKey: id, split: "validation", input: fixture.input,
      expectedOutput: fixture.expectedOutput, privilegedContextRef: null }),
    evaluatorContext: fixture.evaluatorContext,
    evidence: { output: fixture.output, artifactRefs: fixture.artifactRefs, runtimeEventRefs: fixture.runtimeEventRefs,
      infrastructureError: fixture.infrastructureError },
    grader: canonical,
    reward: closure.reward,
    binding,
    expected,
    source: { reward: projection.sourceReward, fixtureSet: projection.fixtureSet, check: projection.calibrationCheck,
      closure: projection.closureRef, fixtureHash: projection.fixtureHash, checkResultHash: projection.checkResultHash },
  };
}

function readPrivateClosure(value: TasksetPackage, reference: ImmutableAssetRef): RewardCalibrationClosure {
  if (reference.visibility !== "host_private" || reference.sizeBytes > MAX_REWARD_CALIBRATION_CLOSURE_BYTES
    || reference.mediaType !== "application/vnd.openpond.reward-calibration-closure+json") fail("calibration_closure_not_private");
  const files = value.files.filter(file => file.asset.id === reference.id);
  if (files.length !== 1 || contentHash(files[0]!.asset) !== contentHash(reference)) fail("calibration_closure_asset_changed");
  const bytes = decodeTasksetPackageFile(files[0]!);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const closure = verifyRewardCalibrationClosure(JSON.parse(text));
  if (contentHash(rewardCalibrationClosureAsset(closure).asset) !== contentHash(reference)) fail("calibration_closure_reference_changed");
  const aliases = value.files.filter(file => file.asset.contentHash === reference.contentHash || file.asset.id === reference.id || file.asset.path === reference.path);
  if (aliases.some(file => file.asset.visibility !== "host_private")) fail("calibration_closure_visible_alias");
  const isAlias = (ref: ImmutableAssetRef) => ref.id === reference.id || ref.path === reference.path || ref.contentHash === reference.contentHash;
  for (const task of value.taskset.tasks) {
    if (task.artifactRefs.some(isAlias) || (task.requiredOutputs ?? []).some(output => output.schemaRef && isAlias(output.schemaRef))
      || task.privilegedContextRef && value.files.some(file => file.asset.id === task.privilegedContextRef && isAlias(file.asset)))
      fail("calibration_closure_task_alias");
    // Literal inlining of the complete exported closure cannot reclassify it.
    if (containsClosure(task.input, text, reference.contentHash) || containsClosure(task.policyVisibleContext, text, reference.contentHash))
      fail("calibration_closure_inline_alias");
  }
  for (const ref of [value.environment.actionSchemaRef, value.environment.observationSchemaRef, value.environment.stateSchemaRef])
    if (ref && isAlias(ref)) fail("calibration_closure_environment_schema_alias");
  for (const metadata of [value.taskset.metadata.environmentResources, value.environment.metadata.resources]) {
    if (metadata === undefined) continue;
    const resources = z.array(z.object({ id: z.string().optional(), path: z.string(), visibility: z.string().optional() }).passthrough()).parse(metadata);
    for (const resource of resources) {
      const file = value.files.find(item => item.asset.path === resource.path);
      // A closure belongs to the grading owner, never an environment resource.
      if (resource.id === reference.id || resource.path === reference.path || file && isAlias(file.asset))
        fail("calibration_closure_environment_resource_alias");
    }
  }
  return closure;
}

function containsClosure(value: unknown, text: string, hash: string): boolean {
  if (typeof value === "string") return value === text || sha256(value) === hash;
  if (!value || typeof value !== "object") return false;
  if (sha256(JSON.stringify(value)) === hash) return true;
  return Object.values(value).some(item => containsClosure(item, text, hash));
}
function fail(code: string): never { throw new Error(code); }


function assertJudgeFixtureMembership(value: TasksetPackage, grader: Extract<GraderSpec, { kind: "model_judge" }>,
  selected: z.infer<typeof ProjectionSchema>, closure: RewardCalibrationClosure): void {
  const graderId = grader.id;
  const authoring = value.taskset.metadata.ordinaryAuthoring ?? value.taskset.metadata.starterAuthoring;
  const mapping = z.object({ judgeCalibrationFixtures: z.record(z.string(), z.array(z.string().min(1)).max(500)) }).passthrough().parse(authoring);
  const expected = closure.check.fixtureRefs.map(ref => `calibration-${contentHash([selected.sourceReward, ref.id])}`);
  if (contentHash(mapping.judgeCalibrationFixtures[graderId] ?? []) !== contentHash(expected)) fail("calibration_judge_membership_changed");
  const fixtures = authoredFixtures(value);
  for (let index = 0; index < expected.length; index++) {
    const matches = fixtures.filter(fixture => fixture.id === expected[index]);
    if (matches.length !== 1) fail("calibration_judge_membership_changed");
    const authored = matches[0]!;
    const projected = ProjectionSchema.parse(authored.metadata.rewardCalibration);
    const expectation = projected.fixture.expected;
    if (expectation.status !== "scored" || typeof expectation.passed !== "boolean"
      || authored.expectedPassed !== expectation.passed || authored.expectedRewardEligible !== grader.rewardEligible
      || authored.label !== (expectation.passed ? "positive" : "negative")
      || contentHash(authored.output) !== contentHash(projected.fixture.output)
      || authored.infrastructureError !== projected.fixture.infrastructureError) fail("calibration_judge_membership_changed");
    const retained = closure.check.fixtureRefs[index]!;
    const result = closure.check.results.find(item => item.fixture.id === retained.id)!;
    if (authored.taskId !== authored.id || projected.fixture.id !== retained.id || projected.fixtureHash !== retained.contentHash
      || contentHash(projected.fixture) !== retained.contentHash || projected.checkResultHash !== contentHash(result)
      || contentHash(projected.sourceReward) !== contentHash(selected.sourceReward)
      || contentHash(projected.fixtureSet) !== contentHash(selected.fixtureSet)
      || contentHash(projected.calibrationCheck) !== contentHash(selected.calibrationCheck)
      || contentHash(projected.closureRef) !== contentHash(selected.closureRef)
      || (projected.graderId ?? projected.sourceReward.id) !== graderId) fail("calibration_judge_membership_changed");
  }
}
