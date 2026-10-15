import { expect, test } from "vitest";
import { hostedRunStageEvidence } from "./hosted-run-stage-evidence.js";

// Failure story: a live graph must not turn a terminal phase into evidence of
// a weight update, expose provider metadata, or display a different team's run.
test("hosted flow keeps execution evidence and owner boundaries", () => {
  const raw = {
    job: {
      id: "job",
      teamId: "team",
      modelProjectId: "project",
      state: "completed",
      targetGroups: 1,
      completedGroups: 1,
      optimizerUpdatesApplied: 0,
      currentPolicyVersion: 1,
      inputBundle: { recipe: { rolloutGroupSize: 2 }, privateAnswer: "private-answer" },
    },
    gpuLeases: [
      {
        state: "terminated",
        gpuType: "A100 80GB",
        observedHourlyUsd: "1.79",
        readyAt: "2026-10-14T18:00:00Z",
        terminatedAt: "2026-10-14T18:05:00Z",
        updatedAt: "2026-10-14T18:05:00Z",
        providerMetadata: { credential: "private-credential" },
      },
    ],
    rolloutGroups: [{ id: "group", groupIndex: 0, state: "completed", rewardMean: "0.25" }],
    rollouts: [{ id: "attempt", groupId: "group", workerSlot: 0, attempt: 1, state: "succeeded" }],
    trajectories: [{ rolloutId: "attempt", reward: "0.25" }],
    checkpoints: [],
    policyVersions: [{ version: 1, served: false }],
    evaluations: [],
  };
  const identity = { jobId: "job", teamId: "team", modelProjectId: "project" };
  const flow = hostedRunStageEvidence(raw, { entries: [] }, identity);
  expect(flow.live).toBe(false);
  expect(flow.nodes.find((node) => node.label === "Update adapter")?.state).toBe("missing");
  expect(flow.nodes.find((node) => node.label === "Activate policy")?.state).toBe("missing");
  expect(flow.groups[0]?.attempts[0]?.reward).toBe(0.25);
  expect(JSON.stringify(flow)).not.toContain("private-");
  // A failed update must remain visible without inventing a failed checkpoint;
  // a later successful retry must clear the stage's stale command failure.
  const failed = {
    ...raw,
    job: { ...raw.job, state: "failed" },
    commands: [{ commandType: "train_step", state: "failed", errorCode: "optimizer_nonfinite", updatedAt: "2026-10-14T18:04:00Z" }],
  };
  const failureFlow = hostedRunStageEvidence(failed, { entries: [] }, identity);
  expect(failureFlow.nodes.find(node => node.label === "Update adapter")).toMatchObject({ state: "failed", error: "train_step: optimizer_nonfinite" });
  expect(failureFlow.nodes.find(node => node.label === "Save checkpoint")?.state).toBe("missing");
  const recovered = hostedRunStageEvidence({ ...failed, job: { ...raw.job, optimizerUpdatesApplied: 1 }, commands: [
    ...failed.commands, { commandType: "train_step", state: "completed", updatedAt: "2026-10-14T18:05:00Z" },
  ] }, { entries: [] }, identity);
  expect(recovered.nodes.find(node => node.label === "Update adapter")).toMatchObject({ state: "done" });
  expect(recovered.nodes.find(node => node.label === "Update adapter")?.error).toBeUndefined();

  // Baseline scoring can occupy the warming phase for minutes. Preserve its
  // actual case progress separately from preparation and optimizer evidence.
  const baseline = {
    kind: "baseline", state: "running", score: null as string | null,
    metrics: { taskCount: 1, targetTaskCount: 3, taskResults: [{ privateAnswer: "private-baseline-answer" }] },
  };
  const baselineRaw = { ...raw, job: { ...raw.job, state: "warming", completedGroups: 0 }, evaluations: [baseline] };
  const partial = hostedRunStageEvidence(baselineRaw, { entries: [] }, identity);
  expect(partial.nodes.find(node => node.label === "Prepare")?.state).toBe("done");
  expect(partial.nodes.find(node => node.label === "Baseline evaluation")).toMatchObject({ state: "active", progress: 1 / 3 });
  expect(partial.nodes.find(node => node.label === "Baseline evaluation")?.detail).toContain("1/3");
  expect(partial.nodes.find(node => node.label === "Update adapter")?.state).toBe("pending");
  expect(JSON.stringify(partial)).not.toContain("private-");
  const completedBaseline = hostedRunStageEvidence({ ...baselineRaw,
    job: { ...baselineRaw.job, state: "update_phase" },
    evaluations: [{ ...baseline, state: "completed", score: "0", metrics: { taskCount: 3, targetTaskCount: 3 } }],
  }, { entries: [] }, identity);
  expect(completedBaseline.nodes.find(node => node.label === "Baseline evaluation")).toMatchObject({ state: "done", progress: 1 });
  expect(completedBaseline.nodes.find(node => node.label === "Baseline evaluation")?.detail).toContain("0.000");
  expect(completedBaseline.nodes.find(node => node.label === "Update adapter")?.state).toBe("active");
  const failedBaseline = hostedRunStageEvidence({ ...baselineRaw, job: { ...baselineRaw.job, state: "failed" },
    evaluations: [{ ...baseline, state: "failed" }],
  }, { entries: [] }, identity);
  expect(failedBaseline.nodes.find(node => node.label === "Baseline evaluation")).toMatchObject({ state: "failed", progress: 1 / 3 });
  expect(failedBaseline.nodes.find(node => node.label === "Update adapter")?.state).toBe("missing");
  const uncounted = hostedRunStageEvidence({ ...baselineRaw, evaluations: [{ ...baseline, metrics: {} }] }, { entries: [] }, identity);
  expect(uncounted.nodes.find(node => node.label === "Baseline evaluation")?.progress).toBeUndefined();
  expect(flow.nodes.some(node => node.label === "Baseline evaluation")).toBe(false);
  const qualification = hostedRunStageEvidence({ ...baselineRaw,
    job: { ...baselineRaw.job, inputBundle: { ...raw.job.inputBundle, executionIntent: { purpose: "collection" } } },
  }, { entries: [] }, identity);
  expect(qualification.nodes.some(node => node.label === "Baseline evaluation")).toBe(false);

  // Draining also owns final candidate evaluation and cleanup. A completed
  // training loop must not stay active and hide that actual evaluation stage.
  const draining = { ...raw, job: { ...raw.job, state: "draining" } };
  expect(hostedRunStageEvidence(draining, { entries: [] }, identity).nodes.find(node => node.label === "Rollouts")?.state).toBe("active");
  for (const state of ["running", "completed"]) {
    const finalEvaluation = hostedRunStageEvidence({ ...draining,
      evaluations: [{ kind: "candidate", state, score: state === "completed" ? "0.25" : null }],
    }, { entries: [] }, identity);
    expect(finalEvaluation.nodes.find(node => node.label === "Rollouts")?.state).toBe("done");
    expect(finalEvaluation.nodes.some(node => node.inLoop && node.state === "active")).toBe(false);
    expect(finalEvaluation.nodes.find(node => node.label === "Evaluate")?.state).toBe(state === "running" ? "active" : "done");
    expect(finalEvaluation.nodes.find(node => node.state === "active")?.label).toBe(state === "running" ? "Evaluate" : undefined);
  }
  const drainingQualification = hostedRunStageEvidence({ ...draining,
    job: { ...draining.job, inputBundle: { ...raw.job.inputBundle, executionIntent: { purpose: "collection" } } },
  }, { entries: [] }, identity);
  expect(drainingQualification.nodes.find(node => node.label === "Rollouts")?.state).toBe("active");
  expect(drainingQualification.nodes.some(node => node.label === "Evaluate")).toBe(false);

  expect(() =>
    hostedRunStageEvidence(
      { ...raw, job: { ...raw.job, teamId: "other-team" } },
      { entries: [] },
      identity,
    ),
  ).toThrow("different training run");
});
