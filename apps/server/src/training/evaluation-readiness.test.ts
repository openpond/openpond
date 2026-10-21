import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTasksetDraft, publishTasksetDraft } from "@openpond/taskset-sdk";
import { SqliteStore } from "../store/store.js";
import { createTaskEvaluationService } from "./evaluation-service.js";

// Execution-only projections can omit calibration cases. Readiness must retain
// the missing-audit advisory without inventing a successful empty audit, while
// still executing and retaining real authored fixtures when they are present.
test("readiness persists without fixtures and audits nonempty calibration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-readiness-"));
  const store = new SqliteStore(home);
  try {
    const service = createTaskEvaluationService({ store, storeDir: home });
    const draft = createTasksetDraft({ id: "execution-only", profileId: "profile", name: "Execution tasks" });
    const prepare = (withFixture: boolean) => publishTasksetDraft({ draft: {
      ...draft, id: withFixture ? "with-calibration" : draft.id,
      objective: "Return the task's answer.",
      tasks: ["train", "frozen_eval"].map(split => ({
        schemaVersion: "openpond.taskData.v1", id: split, clusterKey: split, split,
        input: { prompt: "Return pond" }, expectedOutput: { text: "pond" },
        policyVisibleContext: {}, privilegedContextRef: null, sourceRefs: [], tags: [], metadata: {},
      })),
      graders: [{ id: "answer", version: "1", label: "Answer", kind: "content", weight: 1,
        hardGate: false, rewardEligible: true, privileged: true,
        config: { operator: "final_answer_equals_expected" }, metadata: {} }],
      graderFixtures: withFixture ? [{ id: "correct", taskId: "frozen_eval", label: "positive",
        output: { text: "pond" }, infrastructureError: null, expectedPassed: true,
        expectedRewardEligible: true, metadata: {} }] : [],
    } });
    const empty = prepare(false);
    await store.upsertTaskset(empty);
    const report = await service.readiness(empty.id);
    expect(report.advisories.some(issue => issue.code === "grader_audit_missing")).toBe(true);
    expect(report.blockers.some(issue => issue.code === "grader_fixtures_required")).toBe(true);
    expect((await store.getTaskset(empty.id))?.readiness).toEqual(report);
    expect(await store.listGraderAuditReports(empty.id)).toEqual([]);

    const calibrated = prepare(true);
    await store.upsertTaskset(calibrated);
    const checked = await service.readiness(calibrated.id);
    expect(checked.advisories.some(issue => issue.code === "grader_audit_missing")).toBe(false);
    const [audit] = await store.listGraderAuditReports(calibrated.id);
    expect(audit?.passed).toBe(true);
    expect(audit?.fixtureRefs).toEqual(["correct"]);
    expect(audit?.gradeRefs).toHaveLength(1);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
