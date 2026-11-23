import { expect, test, vi } from "vitest";
import { saveAuthoringDraft } from "../src/learning/authoring-service.js";
import { rewardAuthoringFields } from "../src/learning/reward-authoring.js";
import { LearningDomainError } from "../src/learning/errors.js";
import type { AuthoringDraftInput } from "../src/learning/authoring.js";
import type { LearningTransaction } from "../src/learning/repository.js";

// Failure story: an oversized reward draft escaped as an unexpected server
// failure, encouraging retries. Raw JSON-bound tests do not cover this service
// boundary or prove that rejected content never reaches the repository.
test("oversized authoring drafts are rejected as domain input errors before storage", async () => {
  const get = vi.fn().mockResolvedValue(null);
  const put = vi.fn().mockResolvedValue(undefined);
  const tx = { get, put } as unknown as LearningTransaction;
  const draft: AuthoringDraftInput = {
    id: "reward-draft", targetId: "reward", targetKind: "reward", baseRelease: null,
    editorVersion: "openpond.modelsEditor.v1", fields: rewardAuthoringFields(null, null),
  };
  await saveAuthoringDraft(tx, { draft, expectedRevision: 0 }, "2026-01-01T00:00:00.000Z");
  get.mockClear(); put.mockClear();
  const oversized = { ...draft, fields: { ...draft.fields, code: "x".repeat(131_072) } };
  const failure = await saveAuthoringDraft(tx, { draft: oversized, expectedRevision: 0 }, "2026-01-01T00:00:00.000Z").catch(error => error);
  expect(failure).toBeInstanceOf(LearningDomainError);
  expect(failure).toMatchObject({ code: "authoring_draft_too_large", status: 422 });
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
