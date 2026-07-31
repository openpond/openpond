import { describe, expect, test } from "vitest";
import { TaskMinerRunSchema } from "../packages/contracts/src";
import { nextModelName } from "../apps/web/src/components/labs/model-run-editor-helpers";
import { shouldRevealMinerCandidates } from "../apps/web/src/components/training/training-flow";

describe("Model creation flow helpers", () => {
  test("assigns the next sequential default Model title after earlier Models are renamed", () => {
    expect(nextModelName([])).toBe("Model #1");
    expect(
      nextModelName([{ name: "Model #3" }, { name: "Support specialist" }])
    ).toBe("Model #4");
  });

  test("does not send an advanced workflow back to candidates when persisted Miner state refreshes", () => {
    const succeeded = TaskMinerRunSchema.parse({
      schemaVersion: "openpond.taskMinerRun.v1",
      id: "task_miner_run_succeeded",
      profileId: "default",
      status: "succeeded",
      config: {
        schemaVersion: "openpond.taskMinerConfig.v1",
        enabled: true,
        localOnly: true,
        observationWindowDays: 30,
        minimumRecurrence: 3,
        clustering: "hybrid_deterministic_first",
        consentRequired: true,
      },
      sourceIds: ["source_1"],
      sessionIds: ["session_1"],
      progress: {
        stage: "complete",
        processedSources: 1,
        totalSources: 1,
        candidatesFound: 1,
        skippedSources: 0,
      },
      candidateIds: ["task_candidate_1"],
      cancelRequested: false,
      error: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z",
      updatedAt: "2026-07-14T00:00:01.000Z",
    });

    expect(shouldRevealMinerCandidates("automatic_scope", succeeded)).toBe(true);
    expect(
      shouldRevealMinerCandidates("automatic_candidates", succeeded)
    ).toBe(false);
    expect(shouldRevealMinerCandidates("evidence", succeeded)).toBe(false);
    expect(shouldRevealMinerCandidates("recommendation", succeeded)).toBe(
      false
    );
  });
});
