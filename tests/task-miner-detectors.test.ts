import { describe, expect, test } from "bun:test";
import { createTaskMinerService } from "../apps/server/src/training/task-miner";
import { createTaskMinerBackgroundLoop } from "../apps/server/src/training/task-miner-background-loop";
import { detectRepeatedToolFailures, detectRepeatedUserCorrections } from "../apps/server/src/insights/insight-evidence-detectors";
import { sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("task mining evidence detectors", () => {
  test("detects recurring operational failures and corrections", () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    const failures = [0, 1, 2].map((sequence) => ({ sequence, event: { id: `event_${sequence}`, name: "tool.completed", status: "failed" as const, action: "search", sessionId: "session_1", timestamp, source: "server" as const } }));
    expect(detectRepeatedToolFailures(failures, timestamp)[0]?.item).toMatchObject({ severity: "blocker", type: "tool.repeated_failure" });
    const corrections = [0, 1].map((sequence) => ({ sequence, event: { id: `correction_${sequence}`, name: "turn.started", args: { prompt: sequence ? "Again, that is wrong" : "Fix this result" }, sessionId: "session_1", timestamp, source: "server" as const } }));
    expect(detectRepeatedUserCorrections(corrections, timestamp)[0]?.evidenceSource).toBe("user_correction");
  });

  test("clusters three consented recurring sources and deduplicates reruns", async () => withTrainingStore(async ({ store }) => {
    for (let index = 0; index < 3; index += 1) await store.upsertTrainingSource({ ...sourceFixture(`source_${index}`, `cluster_${index}`), title: `Weekly research workflow ${index}`, metadata: { workflowSignature: "weekly-research", verifiableOutcome: true, frontierCost: true } });
    const service = createTaskMinerService({ store });
    const first = await service.run({ profileId: "default" });
    const second = await service.run({ profileId: "default" });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ workflowSignature: "weekly-research", status: "needs_review", metadata: { sourceCount: 3 } });
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(first[0]?.evidence.every((item) => item.consented)).toBe(true);
  }));

  test("automatically scans an enabled active profile without uploading evidence", async () => withTrainingStore(async ({ store }) => {
    for (let index = 0; index < 3; index += 1) await store.upsertTrainingSource({ ...sourceFixture(`auto_${index}`, `cluster_${index}`), metadata: { workflowSignature: "automatic-workflow" } });
    const service = createTaskMinerService({ store });
    await service.updateConfig("default", { schemaVersion: "openpond.taskMinerConfig.v1", enabled: true, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first", consentRequired: true });
    const loop = createTaskMinerBackgroundLoop({ service, loadProfileState: async () => ({ activeProfile: "default" } as any), isClosing: () => false });
    const result = await loop.tickNow();
    expect(result.skippedReason).toBeNull();
    expect(result.candidates[0]?.workflowSignature).toBe("automatic-workflow");
    expect(result.candidates[0]?.metadata.clustering).toBe("hybrid_deterministic_first");
  }));
});
