import { describe, expect, test } from "vitest";
import {
  ModelArtifactLineageSchema,
  ModelBindingSchema,
  resolveModelBindingPromotionGate,
} from "@openpond/contracts";

const HASH = "a".repeat(64);

function lineage() {
  return ModelArtifactLineageSchema.parse({
    schemaVersion: "openpond.modelArtifactLineage.v1",
    id: "lineage-fixture",
    modelId: "model-fixture",
    artifactId: "artifact-fixture",
    jobId: "job-fixture",
    tasksetId: "taskset-fixture",
    tasksetHash: HASH,
    graderHash: HASH,
    planHash: HASH,
    bundleHash: HASH,
    recipeHash: HASH,
    workerVersion: "worker-fixture",
    trainerVersion: "trainer-fixture",
    importedAt: "2026-07-27T00:00:00.000Z",
    frozenEvaluationArtifactId: null,
    promotable: false,
  });
}

describe("Model binding promotion gate", () => {
  test("keeps an unvalidated lineage blocked", () => {
    expect(resolveModelBindingPromotionGate(lineage())).toBeNull();
  });

  test("accepts a source-owned frozen evaluation", () => {
    expect(
      resolveModelBindingPromotionGate({
        ...lineage(),
        promotable: true,
        frozenEvaluationArtifactId: "evaluation-fixture",
      }),
    ).toEqual({
      kind: "source_frozen_evaluation",
      evaluationArtifactId: "evaluation-fixture",
      canonicalArtifactId: null,
      canonicalDeploymentId: null,
    });
  });

  test("accepts the independently promoted and deployed Sandbox artifact", () => {
    const gate = resolveModelBindingPromotionGate({
      ...lineage(),
      managedServing: {
        schemaVersion: "openpond.managedAdapterServingProjection.v1",
        teamId: "team-fixture",
        source: "sandbox_managed_rl",
        sourceRef: "lineage-fixture",
        canonicalArtifactId: "sandbox-artifact-fixture",
        canonicalArtifactState: "promotable",
        canonicalDeploymentId: "sandbox-deployment-fixture",
        canonicalDeploymentState: "ready",
        state: "ready",
        customerBindingAllowed: true,
        publishedAt: "2026-07-27T00:00:00.000Z",
        lastSyncedAt: "2026-07-27T00:01:00.000Z",
        lastError: null,
      },
    });
    expect(gate).toEqual({
      kind: "sandbox_customer_binding",
      evaluationArtifactId: null,
      canonicalArtifactId: "sandbox-artifact-fixture",
      canonicalDeploymentId: "sandbox-deployment-fixture",
    });
    expect(
      ModelBindingSchema.parse({
        schemaVersion: "openpond.modelBinding.v1",
        id: "binding-fixture",
        profileId: "profile-fixture",
        role: "chat_manual",
        roleTargetId: "default",
        modelArtifactLineageId: "lineage-fixture",
        tasksetId: "taskset-fixture",
        evaluationArtifactId: gate?.evaluationArtifactId ?? null,
        status: "active",
        priorBindingId: null,
        rollbackTargetBindingId: null,
        promotedBy: "profile-fixture",
        promotedAt: "2026-07-27T00:02:00.000Z",
        rolledBackAt: null,
        metadata: {},
      }).evaluationArtifactId,
    ).toBeNull();
  });

  test("does not accept Sandbox until evaluation and deployment are ready", () => {
    expect(
      resolveModelBindingPromotionGate({
        ...lineage(),
        managedServing: {
          schemaVersion: "openpond.managedAdapterServingProjection.v1",
          teamId: "team-fixture",
          source: "sandbox_managed_rl",
          sourceRef: "lineage-fixture",
          canonicalArtifactId: "sandbox-artifact-fixture",
          canonicalArtifactState: "promotable",
          canonicalDeploymentId: "sandbox-deployment-fixture",
          canonicalDeploymentState: "deploying",
          state: "imported",
          customerBindingAllowed: true,
          publishedAt: "2026-07-27T00:00:00.000Z",
          lastSyncedAt: "2026-07-27T00:01:00.000Z",
          lastError: null,
        },
      }),
    ).toBeNull();
  });

  test("does not accept Sandbox until customer binding is allowed", () => {
    expect(
      resolveModelBindingPromotionGate({
        ...lineage(),
        managedServing: {
          schemaVersion: "openpond.managedAdapterServingProjection.v1",
          teamId: "team-fixture",
          source: "sandbox_managed_rl",
          sourceRef: "lineage-fixture",
          canonicalArtifactId: "sandbox-artifact-fixture",
          canonicalArtifactState: "promotable",
          canonicalDeploymentId: "sandbox-deployment-fixture",
          canonicalDeploymentState: "ready",
          state: "ready",
          customerBindingAllowed: false,
          publishedAt: "2026-07-27T00:00:00.000Z",
          lastSyncedAt: "2026-07-27T00:01:00.000Z",
          lastError: null,
        },
      }),
    ).toBeNull();
  });

  test("preserves baseline, candidate activation, rejection, and rollback lineage", () => {
    const baseline = ModelBindingSchema.parse({
      schemaVersion: "openpond.modelBinding.v1",
      id: "binding-baseline",
      profileId: "profile-fixture",
      role: "chat_manual",
      roleTargetId: "default",
      modelArtifactLineageId: "lineage-baseline",
      tasksetId: "taskset-fixture",
      evaluationArtifactId: "evaluation-baseline",
      status: "active",
      priorBindingId: null,
      rollbackTargetBindingId: null,
      promotedBy: "profile-fixture",
      promotedAt: "2026-07-27T00:00:00.000Z",
      rolledBackAt: null,
      metadata: {},
    });
    expect(resolveModelBindingPromotionGate(lineage())).toBeNull();
    const gate = resolveModelBindingPromotionGate({
      ...lineage(),
      promotable: true,
      frozenEvaluationArtifactId: "evaluation-candidate",
    });
    expect(gate?.kind).toBe("source_frozen_evaluation");
    const candidate = ModelBindingSchema.parse({
      ...baseline,
      id: "binding-candidate",
      modelArtifactLineageId: "lineage-candidate",
      evaluationArtifactId: gate?.evaluationArtifactId ?? null,
      priorBindingId: baseline.id,
      rollbackTargetBindingId: baseline.id,
      promotedAt: "2026-07-27T01:00:00.000Z",
    });
    const rolledBackCandidate = ModelBindingSchema.parse({
      ...candidate,
      status: "rolled_back",
      rolledBackAt: "2026-07-27T02:00:00.000Z",
    });
    const restored = ModelBindingSchema.parse({
      ...baseline,
      id: "binding-baseline-restored",
      priorBindingId: candidate.id,
      promotedAt: "2026-07-27T02:00:00.000Z",
      metadata: {
        action: "rollback",
        rolledBackBindingId: candidate.id,
        restoredFromBindingId: baseline.id,
      },
    });
    expect(candidate).toMatchObject({
      priorBindingId: baseline.id,
      rollbackTargetBindingId: baseline.id,
    });
    expect(rolledBackCandidate).toMatchObject({ status: "rolled_back" });
    expect(restored).toMatchObject({
      status: "active",
      priorBindingId: candidate.id,
      modelArtifactLineageId: baseline.modelArtifactLineageId,
    });
  });
});
