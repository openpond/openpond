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

  expect(() =>
    hostedRunStageEvidence(
      { ...raw, job: { ...raw.job, teamId: "other-team" } },
      { entries: [] },
      identity,
    ),
  ).toThrow("different training run");
});
