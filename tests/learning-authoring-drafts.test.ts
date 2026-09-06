import { expect, test } from "vitest";
import { AuthoringDraftSchema, assertLearningContentHash, learningRef, sealLearningContent } from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture } from "./helpers/learning-fixtures";

// Failure story: an unfinished editor must survive restart without publishing;
// stale concurrent publication must roll back both the release and draft receipt.
test("durable authoring preserves unfinished input and atomically finalizes only the exact saved revision", async () => {
  await withTempDirectory("openpond-authoring-drafts-", async (home) => {
    const store = new SqliteLearningStore(home);
    try {
      const fixture = await learningFixture(store.learningRepository());
      const input = { id: "draft-reward", targetKind: "reward", targetId: "new-reward", baseRelease: null, editorVersion: "openpond.modelsEditor.v1", fields: { name: "Unfinished", description: "", kind: "custom_verifier", fields: "", outputField: "", expectedField: "", expectedValue: "", schema: "{unfinished", reference: "", events: "", code: "export function", exportName: "verify", timeout: "", rubric: "", providerId: "", modelId: "", modelRevision: "", temperature: "", reviewerRole: "", learnedId: "", learnedHash: "", inputContract: "", minimum: "", maximum: "" } };
      const save = { action: "save_draft", operationId: "save-initial", expectedRevision: 0, draft: input };
      const first = await fixture.command(save);
      expect(await fixture.command(save)).toEqual(first);
      const initial = AuthoringDraftSchema.parse(first.resources[0]);
      assertLearningContentHash(initial);
      expect((await fixture.service.list(learningContext, "draft", { parentId: "reward", status: "draft" })).items).toHaveLength(1);
      await expect(fixture.service.get(learningContext, "reward", input.targetId)).rejects.toThrow("learning_resource_not_found");
      const reopened = new SqliteLearningStore(home);
      try { expect(await reopened.learningRepository().transaction(learningContext.scope, tx => tx.get("draft", input.id))).toEqual(initial); } finally { await reopened.close(); }
      const updates = await Promise.allSettled(["A", "B"].map(name => fixture.command({ action: "save_draft", expectedRevision: 1, draft: { ...input, fields: { ...input.fields, name } } })));
      expect(updates.filter(value => value.status === "fulfilled")).toHaveLength(1);
      expect(updates.filter(value => value.status === "rejected")).toHaveLength(1);
      const current = await fixture.service.get(learningContext, "draft", input.id);
      const { contentHash: _rewardHash, ...rewardContent } = fixture.reward;
      const reward = { ...rewardContent, id: input.targetId };
      const release = learningRef(sealLearningContent(reward));
      const publication = { action: "publish", operationId: "publish-draft", kind: "reward", expectedRevision: 0, content: reward, finalizeDraft: { draft: learningRef(initial), targetKind: "reward", release } };
      await expect(fixture.command(publication)).rejects.toThrow("authoring_draft_revision_stale");
      await expect(fixture.service.get(learningContext, "reward", input.targetId)).rejects.toThrow("learning_resource_not_found");
      publication.finalizeDraft.draft = learningRef(current);
      const published = await fixture.command(publication);
      expect(await fixture.command(publication)).toEqual(published);
      const completed = AuthoringDraftSchema.parse(published.resources[1]);
      expect(completed.status).toBe("published");
      expect(completed.publishedRelease).toEqual(release);
      assertLearningContentHash(completed);
      expect((await fixture.service.list(learningContext, "draft", { status: "draft" })).items).toHaveLength(0);
      await expect(fixture.command({ action: "save_draft", expectedRevision: completed.revision, draft: input })).rejects.toThrow("authoring_draft_identity_conflict");
      await expect(fixture.service.command({ ...learningContext, actor: { id: "source", role: "source", sourceId: fixture.source.id } }, save)).rejects.toThrow("learning_source_not_authorized");
      const archiveInput = { ...input, id: "archive-draft" };
      const toArchive = AuthoringDraftSchema.parse((await fixture.command({ action: "save_draft", expectedRevision: 0, draft: archiveInput })).resources[0]);
      const archived = AuthoringDraftSchema.parse((await fixture.command({ action: "archive_draft", draft: learningRef(toArchive) })).resources[0]);
      expect(archived.status).toBe("archived");
      assertLearningContentHash(archived);
    } finally { await store.close(); }
  });
});
