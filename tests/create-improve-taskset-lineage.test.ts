import { describe, expect, test } from "vitest";
import { SessionSchema } from "@openpond/contracts";

import {
  assertTasksetRefMatches,
  createEvidenceSnapshot,
  createTasksetRef,
} from "../apps/server/src/training/create-improve-taskset-lineage";
import { attachModelTargetRefs } from "../apps/server/src/runtime/create-pipeline/target-adapters";
import { continueLabAgentRunFromTaskset } from "../apps/web/src/lib/create-pipeline-request";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import {
  FIXED_TIME,
  proposalFixture,
  sourceFixture,
  tasksetFixture,
} from "./helpers/training-fixtures";
import { advanceUnexecutedModelRunTasksetRef } from "../apps/server/src/training/model-create-improve";
import { computeTasksetHash } from "../packages/taskset-sdk/src";
import { TasksetSchema } from "../packages/contracts/src";

describe("shared Create/Improve Taskset lineage", () => {
  test("freezes consented evidence and the exact approved Taskset revision", () => {
    const taskset = tasksetFixture({ ready: true });
    const evidence = createEvidenceSnapshot({
      objective: taskset.objective,
      sources: [sourceFixture(), sourceFixture("source_eval", "cluster_eval")],
      timestamp: FIXED_TIME,
    });
    const ref = createTasksetRef({
      taskset,
      proposal: proposalFixture(),
      evidenceSnapshotIds: [evidence.id],
      approvedAt: FIXED_TIME,
    });

    expect(evidence).toMatchObject({
      schemaVersion: "openpond.createImprove.evidenceSnapshot.v1",
      consent: { status: "granted", scope: "selected_turns" },
      reviewerIntent: taskset.objective,
    });
    expect(evidence.sources.map((source) => source.sourceHash)).toEqual(
      taskset.sourceRefs.map((source) => source.sourceHash),
    );
    expect(ref).toMatchObject({
      id: taskset.id,
      revision: 1,
      contentHash: taskset.contentHash,
      evidenceSnapshotIds: [evidence.id],
      targetRecommendation: { kind: "model", confidence: 0.9 },
    });
    expect(ref.authoringSplitRefs).toEqual(["task_train"]);
    expect(ref.privateSplitRefs).toEqual(["task_eval"]);
    expect(() => assertTasksetRefMatches(ref, taskset)).not.toThrow();
    expect(() => assertTasksetRefMatches(ref, {
      ...taskset,
      contentHash: "changed00000000",
    })).toThrow("Taskset lineage mismatch");
  });

  test("prevents the Model adapter from silently replacing the approved Taskset", () => {
    const taskset = tasksetFixture({ ready: true });
    const evidence = createEvidenceSnapshot({
      objective: taskset.objective,
      sources: taskset.sourceRefs,
      timestamp: FIXED_TIME,
    });
    const tasksetRef = createTasksetRef({
      taskset,
      proposal: proposalFixture(),
      evidenceSnapshotIds: [evidence.id],
      approvedAt: FIXED_TIME,
    });
    const run = createImproveRunFixture({
      target: {
        kind: "model",
        id: taskset.id,
        displayName: taskset.name,
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
      state: "evaluating",
      evidenceSnapshots: [evidence],
      tasksetRef,
      targetSelection: {
        status: "confirmed",
        preselectedKind: "model",
        confirmedKind: "model",
      },
    });

    expect(() => attachModelTargetRefs({
      run,
      tasksetId: "taskset_substitution",
      trainingPlanId: "plan_1",
    })).toThrow("cannot replace approved Taskset");

    const attached = attachModelTargetRefs({
      run,
      tasksetId: taskset.id,
      trainingPlanId: "plan_1",
      trainingJobId: "job_1",
    });
    expect(attached.tasksetRef).toEqual(tasksetRef);
    expect(attached.candidates).toEqual([
      expect.objectContaining({
        id: `model_candidate_${run.id}`,
        target: expect.objectContaining({
          kind: "model",
          trainingPlanId: "plan_1",
        }),
        status: "checking",
        tasksetRef,
        sourceRefs: [taskset.id],
      }),
    ]);
    expect(attached.externalExecutionRefs[0]?.metadata).toMatchObject({
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
    });
  });

  test("advances an unexecuted Model authoring run to an approved Taskset revision", () => {
    const original = tasksetFixture({ ready: true });
    const evidence = createEvidenceSnapshot({
      objective: original.objective,
      sources: original.sourceRefs,
      timestamp: FIXED_TIME,
    });
    const originalRef = createTasksetRef({
      taskset: original,
      evidenceSnapshotIds: [evidence.id],
      approvedAt: FIXED_TIME,
    });
    const run = createImproveRunFixture({
      state: "ready",
      target: {
        kind: "model",
        id: original.id,
        displayName: original.name,
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
      evidenceSnapshots: [evidence],
      tasksetRef: originalRef,
      candidates: [{
        id: "model_candidate_revision",
        target: {
          kind: "model",
          id: original.id,
          displayName: original.name,
          trainingPlanId: null,
          trainingJobId: null,
          artifactId: null,
        },
        status: "authored",
        git: null,
        parentCandidateId: null,
        tasksetRef: originalRef,
        authoringModelRef: null,
        allowedPaths: [],
        sourceRefs: [original.id],
        artifactRefs: [],
        checkRefs: [],
        evaluationReceiptRefs: [],
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
        metadata: {},
      }],
    });
    const revisedDraft = TasksetSchema.parse({
      ...original,
      revision: 2,
      status: "needs_review",
      readiness: null,
      updatedAt: "2026-07-17T12:00:00.000Z",
      metadata: { ...original.metadata, expertBootstrapApproved: true },
      contentHash: "00000000",
    });
    const revised = TasksetSchema.parse({
      ...revisedDraft,
      contentHash: computeTasksetHash(revisedDraft),
    });

    const advanced = advanceUnexecutedModelRunTasksetRef(run, revised);

    expect(advanced.revision).toBe(run.revision + 1);
    expect(advanced.tasksetRef).toMatchObject({
      id: revised.id,
      revision: 2,
      contentHash: revised.contentHash,
    });
    expect(advanced.candidates[0]?.tasksetRef).toEqual(advanced.tasksetRef);
    expect(advanced.metadata).toMatchObject({
      tasksetRevision: 2,
      tasksetHash: revised.contentHash,
    });

    const executing = attachModelTargetRefs({
      run,
      tasksetId: original.id,
      trainingPlanId: "plan_original",
      trainingJobId: "job_original",
    });
    expect(() => advanceUnexecutedModelRunTasksetRef(executing, revised))
      .toThrow("already executed Taskset");
  });

  test("retains a failed Model candidate when a blocked run starts retraining", () => {
    const taskset = tasksetFixture({ ready: true });
    const tasksetRef = createTasksetRef({
      taskset,
      evidenceSnapshotIds: ["evidence_retry"],
      approvedAt: FIXED_TIME,
    });
    const initial = createImproveRunFixture({
      state: "evaluating",
      tasksetRef,
      target: {
        kind: "model",
        id: taskset.id,
        displayName: taskset.name,
        trainingPlanId: null,
        trainingJobId: null,
        artifactId: null,
      },
    });
    const first = attachModelTargetRefs({
      run: initial,
      tasksetId: taskset.id,
      trainingPlanId: "plan_first",
      trainingJobId: "job_first",
      artifactId: "artifact_first",
      evaluations: [{
        subject: "candidate",
        attemptRefs: ["attempt_first"],
        gradeRefs: ["grade_first"],
        total: 1,
        passed: 0,
        failed: 1,
        executionContractHash: "contract_first",
      }],
    });
    const blocked = {
      ...first,
      state: "blocked" as const,
      blockedReason: "The first candidate failed frozen evaluation.",
    };

    const retraining = attachModelTargetRefs({
      run: blocked,
      tasksetId: taskset.id,
      trainingPlanId: "plan_second",
      trainingJobId: "job_second",
    });

    expect(retraining).toMatchObject({
      state: "evaluating",
      blockedReason: null,
      target: {
        kind: "model",
        trainingPlanId: "plan_second",
        trainingJobId: "job_second",
        artifactId: null,
      },
    });
    expect(retraining.candidates).toHaveLength(2);
    expect(retraining.candidates[0]).toMatchObject({
      id: `model_candidate_${initial.id}`,
      target: {
        kind: "model",
        trainingJobId: "job_first",
        artifactId: "artifact_first",
      },
      status: "evaluated",
    });
    expect(retraining.candidates[1]).toMatchObject({
      id: `model_candidate_${initial.id}_job_second`,
      parentCandidateId: `model_candidate_${initial.id}`,
      target: {
        kind: "model",
        trainingJobId: "job_second",
        artifactId: null,
      },
      status: "checking",
    });
    expect(retraining.externalExecutionRefs.map((ref) => ref.id)).toEqual([
      "job_first",
      "job_second",
    ]);

    const failedRetry = attachModelTargetRefs({
      run: {
        ...first,
        state: "failed",
        blockedReason: null,
      },
      tasksetId: taskset.id,
      trainingPlanId: "plan_failed_retry",
      trainingJobId: "job_failed_retry",
    });
    expect(failedRetry).toMatchObject({
      state: "evaluating",
      target: {
        kind: "model",
        trainingJobId: "job_failed_retry",
        artifactId: null,
      },
    });
    expect(failedRetry.candidates).toHaveLength(2);

    const cancelledRetry = attachModelTargetRefs({
      run: {
        ...first,
        state: "cancelled",
        blockedReason: null,
      },
      tasksetId: taskset.id,
      trainingPlanId: "plan_cancelled_retry",
      trainingJobId: "job_cancelled_retry",
    });
    expect(cancelledRetry).toMatchObject({
      state: "evaluating",
      target: {
        kind: "model",
        trainingJobId: "job_cancelled_retry",
        artifactId: null,
      },
    });
    expect(cancelledRetry.candidates).toHaveLength(2);
    expect(cancelledRetry.candidates[1]).toMatchObject({
      parentCandidateId: `model_candidate_${initial.id}`,
      target: {
        kind: "model",
        trainingJobId: "job_cancelled_retry",
        artifactId: null,
      },
      status: "checking",
    });
  });

  test("continues Agent authoring on the exact approved run and Taskset revision", () => {
    const taskset = tasksetFixture();
    const tasksetRef = createTasksetRef({
      taskset,
      proposal: proposalFixture(),
      evidenceSnapshotIds: ["evidence_snapshot_fixture"],
      approvedAt: "2026-07-16T12:00:00.000Z",
    });
    const authoringRun = createImproveRunFixture({
      id: "create_improve_shared_agent",
      state: "ready",
      tasksetRef,
      targetSelection: {
        status: "confirmed",
        preselectedKind: "agent",
        confirmedKind: "agent",
      },
    });
    const continued = continueLabAgentRunFromTaskset({
      authoringRun,
      objective: "Create an Agent that triages support requests.",
      operation: "create",
      payload: null,
      session: SessionSchema.parse({
        id: "session_shared_agent",
        provider: "openpond",
        title: "Shared Agent authoring",
        appId: null,
        appName: null,
        cwd: "/profiles/default",
        codexThreadId: null,
        createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z",
        status: "idle",
        pinned: false,
        archived: false,
        order: 0,
      }),
    });

    expect(continued.id).toBe(authoringRun.id);
    expect(continued.revision).toBe(authoringRun.revision + 1);
    expect(continued.state).toBe("planning");
    expect(continued.target.kind).toBe("agent");
    expect(continued.tasksetRef).toEqual(tasksetRef);
    expect(continued.metadata).toMatchObject({
      sharedAuthoringRun: true,
      tasksetRevision: taskset.revision,
      tasksetHash: taskset.contentHash,
    });
  });
});
