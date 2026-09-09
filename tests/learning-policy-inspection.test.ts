import { expect, test } from "vitest";
import { createLearningService, learningRef, taskFamilyReservations, LearningIterationSchema, type LearningRepository } from "@openpond/evals/learning";

import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { learningContext, learningNow } from "./helpers/learning-fixtures";
import { learningIterationFixture } from "./helpers/learning-iteration-fixtures";
import { withTempDirectory } from "./helpers/temp-directory";

// A Model readiness read must neither consume approved examples nor promise a
// reservation that shared review, family-isolation or lifecycle rules reject.
test("policy inspection stays read-only and follows current admission and chain state", async () => {
  await withTempDirectory("openpond-policy-inspection-", async home => {
    const store = new SqliteLearningStore(home);
    const repository = store.learningRepository();
    const noWrites: LearningRepository = { transaction: (scope, callback) => repository.transaction(scope, tx => callback({
      ...tx,
      put: async () => { throw new Error("Inspection wrote a resource"); },
      saveOperation: async () => { throw new Error("Inspection wrote an operation"); },
      reserveFamilySplit: async () => { throw new Error("Inspection reserved a family"); },
    })) };
    const service = createLearningService(noWrites, { now: () => learningNow });
    try {
      const f = await learningIterationFixture(repository);
      const policy = await f.publishPolicy();
      const evidence = await f.submit();
      const inspect = () => service.inspectPolicy(learningContext, learningRef(policy));
      expect(await inspect()).toMatchObject({ policy: learningRef(policy), modelProjectId: "model", canReserve: false,
        chain: null, counts: { eligible: 0, awaitingReview: 1, excluded: 0, consumed: 0 },
        blockers: [{ code: "learning_waiting_for_review" }], budget: { committedSpendUsd: 0 } });
      await f.approve(evidence);
      expect(await inspect()).toMatchObject({ canReserve: true, counts: { eligible: 1, awaitingReview: 0 }, blockers: [] });
      for (const kind of ["iteration", "reservation", "consumption", "batch", "package", "chain"] as const) {
        expect((await f.service.list(learningContext, kind)).items).toHaveLength(0);
      }
      const iteration = LearningIterationSchema.parse((await f.reserve(policy, "after-inspection")).resources[0]);
      expect(await inspect()).toMatchObject({ canReserve: false, chain: { activeIterationId: iteration.id, latestIterationId: iteration.id },
        counts: { eligible: 0, consumed: 1 }, budget: { reservedSpendUsd: 2, committedSpendUsd: 2 } });
      await f.cancel(iteration.id);
      const later = await f.submit({ idempotencyKey: "later", exampleId: "later", familyKey: "held-out-family", input: { question: "Held-out relative" } });
      await f.approve(later);
      await repository.transaction(learningContext.scope, async tx => {
        for (const reservation of taskFamilyReservations(later, f.definition)) {
          await tx.reserveFamilySplit(reservation.namespace, reservation.kind, reservation.key, "frozen_eval");
        }
      });
      const isolated = await inspect();
      expect(isolated).toMatchObject({ canReserve: false, counts: { eligible: 1, consumed: 1 }, budget: { committedSpendUsd: 0 } });
      expect(isolated.blockers).toHaveLength(1);
      await expect(f.reserve(policy, "held-out-isolation")).rejects.toThrow(isolated.blockers[0]!.code);
      const paused = await f.publishPolicy(policy, { enabled: false, limits: { ...policy.limits, cooldownSeconds: 60 } });
      await expect(inspect()).rejects.toThrow("learning_policy_revision_stale");
      const pausedState = await service.inspectPolicy(learningContext, learningRef(paused));
      expect(pausedState.cooldownUntil).toBe("2026-09-06T12:01:00.000Z");
      expect(pausedState.blockers.map(value => value.code)).toEqual(expect.arrayContaining(["learning_policy_paused", "learning_iteration_cooldown"]));
      const { contentHash: _sourceHash, ...sourceContent } = f.source;
      await f.command({ action: "publish", kind: "source", expectedRevision: f.source.revision,
        content: { ...sourceContent, revision: f.source.revision + 1, enabled: false } });
      const disabledSource = await service.inspectPolicy(learningContext, learningRef(paused));
      expect(disabledSource.counts).toBeNull();
      expect(disabledSource.blockers.map(value => value.code)).toContain("learning_source_disabled");
      await expect(service.inspectPolicy({ ...learningContext, actor: { id: "producer", role: "source", sourceId: f.source.id } }, learningRef(paused))).rejects.toThrow("learning_read_not_authorized");
      await expect(service.inspectPolicy({ ...learningContext, scope: "another-team" }, learningRef(paused))).rejects.toThrow("learning_resource_not_found");
      expect((await f.service.list(learningContext, "reservation")).items).toHaveLength(1);
    } finally { await store.close(); }
  });
});
