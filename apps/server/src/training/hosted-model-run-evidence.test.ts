import { describe, expect, it, vi } from "vitest";
import type { TrainingJob } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { createHostedModelRunEvidence } from "./hosted-model-run-evidence.js";

const remote = vi.hoisted(() => ({ getJob: vi.fn(), events: vi.fn(), outputs: vi.fn(), evaluationTasks: vi.fn() }));
vi.mock("openpond-sdk/training", () => ({ createTrainingClient: () => remote }));

describe("API-created run evidence boundaries", () => {
  // Imported runs have no local execution manifest; they must retain the same
  // immutable evaluation references without letting a workspace switch reuse access.
  it("reads retained evidence without a local plan and rejects foreign workspace and policy evidence", async () => {
    let teamId = "team-a";
    let job = { id: "job-a", metadata: { modelProjectId: "model-a", hostedModelProjectId: "hosted-a", hostedTeamId: "team-a" } } as unknown as TrainingJob;
    const store = {
      getModelProject: async () => ({ hosted: { apiOrigin: "https://staging-api.openpond.ai", teamId: "team-a", projectId: "hosted-a" } }),
      getTrainingJob: async () => job,
      saveTrainingJob: async (value: TrainingJob) => { job = value; },
    } as unknown as SqliteStore;
    const service = createHostedModelRunEvidence({ store, resolveAccess: async () => ({ teamId, token: "test-token", apiBaseUrl: "https://staging-api.openpond.ai" }) });
    remote.getJob.mockResolvedValue({ id: "job-a", teamId: "team-a", modelProjectId: "hosted-a", portableProjectId: "model-a", state: "succeeded", accruedSpendUsd: 0.2, rolloutProgress: { groupsTarget: 2, optimizerUpdatesApplied: 2, optimizerUpdatesSkipped: 0 } });
    remote.events.mockResolvedValue([]);
    remote.outputs.mockResolvedValue({ outputs: [{ id: "eval-a", contentHash: "a".repeat(64), kind: "evaluation", metadata: { kind: "candidate", policyVersion: 2, score: 0, passed: true, metrics: { taskCount: 4 } } }], receipt: null });
    await service.refresh(job);
    expect(job.metadata.managedTrainingEvidence).toMatchObject({ providerRunId: "job-a", evaluations: [{ reference: { id: "eval-a", contentHash: "a".repeat(64) }, taskCount: 4 }] });
    remote.evaluationTasks.mockResolvedValue({ teamId: "team-a", kind: "candidate", policyVersion: 2 });
    await service.evaluationTasks(job, "eval-a", { limit: 25 });
    expect(remote.evaluationTasks).toHaveBeenCalledWith("job-a", { id: "eval-a", contentHash: "a".repeat(64) }, { limit: 25 });
    remote.evaluationTasks.mockResolvedValue({ teamId: "team-a", kind: "candidate", policyVersion: 3 });
    await expect(service.evaluationTasks(job, "eval-a", {})).rejects.toThrow("recorded run policy");
    teamId = "team-b";
    const reads = remote.getJob.mock.calls.length;
    await expect(service.refresh(job)).rejects.toThrow("active workspace");
    await expect(service.evaluationTasks(job, "eval-a", {})).rejects.toThrow("active workspace");
    expect(remote.getJob).toHaveBeenCalledTimes(reads);
  });
});
