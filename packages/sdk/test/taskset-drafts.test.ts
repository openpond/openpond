import { expect, it } from "vitest";
import { sha256 } from "@openpond/harness";
import { createTasksetDraft, TasksetDraftSchema, draftPublishIssues, createTasksetDraftFile, decodeTasksetDraftFileContent, isWritableTasksetDraftFilePath, MAX_TASKSET_DRAFT_EDIT_FILE_BYTES } from "../src/taskset-drafts.js";
import { createTasksetDraftWorkspace, validateTasksetDraftWorkspace, readTasksetDraftWorkspaceFile, saveTasksetDraftWorkspaceDocument, saveTasksetDraftWorkspaceFile } from "../src/taskset-drafts.js";

// An editor must retain incomplete work without treating it as publishable;
// published, benchmark and structured-output documents still require their bindings.
it("retains incomplete editor documents and distinguishes publication requirements", () => {
  const draft = createTasksetDraft({ profileId: "workspace", id: "draft", now: "2026-09-08T12:00:00.000Z" });
  expect(TasksetDraftSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  expect(draftPublishIssues(draft).map(issue => issue.code)).toEqual(["name_missing", "objective_missing", "tasks_missing"]);
  expect(TasksetDraftSchema.safeParse({ ...draft, status: "published" }).success).toBe(false);
  expect(TasksetDraftSchema.safeParse({ ...draft, purpose: "benchmark" }).success).toBe(false);
  expect(TasksetDraftSchema.safeParse({ ...draft, output: { mode: "structured_json", jsonSchema: null, renderer: null } }).success).toBe(false);
});

// Durable snapshots must reject lost updates and forged ownership while retaining
// all original files; draft editing cannot mutate an earlier stored revision.
it("seals mutable draft snapshots with document and file revision checks", () => {
  const now = "2026-09-08T12:00:00.000Z";
  const draft = createTasksetDraft({ profileId: "workspace", id: "draft", now, modelScope: { modelId: "model", expectedModelRevision: 1 } });
  const original = { path: "private/input.bin", contentHash: sha256(new Uint8Array([0, 255])), sizeBytes: 2, base64: "AP8=" };
  const retained = { ...original, path: "source-artifacts/source.bin" };
  const first = createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft, files: [retained, original] });
  expect(validateTasksetDraftWorkspace(JSON.parse(JSON.stringify(first)))).toEqual(first);
  const mutation = { draftId: draft.id, expectedDraftRevision: 1, path: original.path, expectedFileHash: original.contentHash, content: { encoding: "utf8" as const, data: "changed" } };
  const second = saveTasksetDraftWorkspaceFile({ workspace: first, mutation, now });
  expect(readTasksetDraftWorkspaceFile(second, original.path).file.content.data).toBe("changed");
  expect(readTasksetDraftWorkspaceFile(first, original.path).file.content).toEqual({ encoding: "base64", data: "AP8=" });
  expect(second.files.find(file => file.path === retained.path)).toEqual(retained);
  expect(() => saveTasksetDraftWorkspaceFile({ workspace: second, mutation, now })).toThrow("changed");
  expect(() => saveTasksetDraftWorkspaceFile({ workspace: second, mutation: { ...mutation, expectedDraftRevision: 2 }, now })).toThrow("file changed");
  expect(() => saveTasksetDraftWorkspaceFile({ workspace: first, mutation: { ...mutation, path: retained.path }, now })).toThrow("managed");
  expect(() => saveTasksetDraftWorkspaceDocument({ workspace: second, expectedDraftRevision: 1, draft: second.draft, now })).toThrow("changed");
  expect(() => saveTasksetDraftWorkspaceDocument({ workspace: second, expectedDraftRevision: 2, draft: { ...second.draft, profileId: "foreign" }, now })).toThrow("ownership");
  const third = saveTasksetDraftWorkspaceDocument({ workspace: second, expectedDraftRevision: 2, draft: { ...second.draft, objective: "Incomplete work" }, now });
  expect(third.draft.revision).toBe(3);
  expect(third.files).toEqual(second.files);
  expect(() => validateTasksetDraftWorkspace({ ...third, draft: { ...third.draft, objective: "tampered" } })).toThrow("retained bytes");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [original, original] })).toThrow("unique");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [original, { ...original, path: "private/input.bin/nested" }] })).toThrow("directory");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [{ ...original, base64: "AAA=" }] })).toThrow("retained bytes");
  expect(() => createTasksetDraftWorkspace({ schemaVersion: first.schemaVersion, draft, files: [{ ...original, path: "taskset.json" }] })).toThrow("draft document");
  const published = createTasksetDraftWorkspace({ schemaVersion: third.schemaVersion, files: third.files,
    draft: { ...third.draft, status: "published", publishedTasksetRef: { id: "release", revision: 1, contentHash: "a".repeat(64) } } });
  expect(() => saveTasksetDraftWorkspaceDocument({ workspace: published, expectedDraftRevision: 3, draft: published.draft, now })).toThrow("immutable");
});

// Saving an untouched code/binary file must preserve its admitted bytes, and
// a client must not bypass editor limits or write retained authoring history.
it("round-trips exact editor bytes and enforces canonical transport and managed paths", () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("export const grade = () => 1;\n"), new Uint8Array([239, 187, 191, 97]), new Uint8Array([0, 255, 128, 13, 10])]) {
    const file = createTasksetDraftFile("graders/source.ts", bytes);
    expect(file.contentHash).toBe(sha256(bytes));
    expect(decodeTasksetDraftFileContent(file.content)).toEqual(bytes);
  }
  expect(isWritableTasksetDraftFilePath("taskset.json")).toBe(false);
  expect(isWritableTasksetDraftFilePath("source-artifacts/revision/source.ts")).toBe(false);
  expect(() => isWritableTasksetDraftFilePath("nested/.env")).toThrow();
  expect(() => decodeTasksetDraftFileContent({ encoding: "base64", data: "AP8" })).toThrow();
  expect(() => createTasksetDraftFile("large.bin", new Uint8Array(MAX_TASKSET_DRAFT_EDIT_FILE_BYTES + 1))).toThrow();
  expect(() => decodeTasksetDraftFileContent({ encoding: "utf8", data: "a".repeat(MAX_TASKSET_DRAFT_EDIT_FILE_BYTES + 1) })).toThrow();
});

// Human review must publish an immutable rubric without fabricated automated
// calibration, while fixture-free automated graders and human optimizer rewards
// remain inadmissible through the same package compiler.
it("publishes human-only review as pending without weakening automated reward gates", async () => {
  const { compileTasksetDraftWorkspace } = await import("../src/taskset-draft-package-compiler.js");
  const { gradeEvidence } = await import("@openpond/evals/graders");
  const now = "2026-10-02T00:00:00.000Z";
  const draft = createTasksetDraft({ profileId: "workspace", id: "owner-review", name: "Owner review", now });
  const source = {
    schemaVersion: "openpond.generatedDatasetSource.v1", kind: "generated", id: "source",
    profileId: "workspace", title: "Reviewed fixture", sourceHash: "a".repeat(64), occurredAt: now,
    licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed",
    generatorId: "test", generatorVersion: "1", seed: 0, generatorHash: "a".repeat(64), metadata: {},
  };
  const human = { id: "owner", version: "1", label: "Owner rubric", kind: "human", weight: 1,
    hardGate: false, rewardEligible: false, privileged: true, rubric: "Assess the recorded answer.", reviewerRole: "owner", metadata: {} };
  const ready = TasksetDraftSchema.parse({ ...draft, objective: "Review the recorded answer", sourceRefs: [source],
    tasks: [{ schemaVersion: "openpond.taskData.v1", id: "case", clusterKey: "family", split: "frozen_eval",
      input: { prompt: "Request" }, expectedOutput: null, privilegedContextRef: null, sourceRefs: [source.id], metadata: {} }],
    graders: [human], graderFixtures: [] });
  const compile = (value: typeof ready) => compileTasksetDraftWorkspace({
    workspace: createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft: value, files: [] }),
    preparation: null, adapterId: "openpond-test", now,
  });
  const published = compile(ready);
  expect(published.verifierSet.calibrationReceiptRefs).toEqual([]);
  expect(published.taskset.graders[0]).toMatchObject({ kind: "human", rewardEligible: false, reviewerRole: "owner" });
  const grade = await gradeEvidence({ task: published.taskset.tasks[0]!, graders: published.taskset.graders,
    evidence: { output: { text: "Recorded answer" }, artifactRefs: [], runtimeEventRefs: [] } });
  expect(grade[0]).toMatchObject({ status: "pending", score: null, rewardEligible: false });
  expect(() => compile(TasksetDraftSchema.parse({ ...ready, graders: [{ ...human, rewardEligible: true }] }))).toThrow(/online optimizer reward/);
  // A published reusable Human rubric must retain its original asset identity
  // and form through the package compiler, or server-side exact-release checks
  // reject owner review despite unchanged rubric text.
  const learning = await import("@openpond/evals/learning");
  const { createRewardBinding, compileBoundGraders } = await import("@openpond/evals/rewards");
  const { projectLearningBatchGraders } = await import("../src/taskset-package-grader-projection.js");
  const retained = learning.compileRewardAuthoring({ id: "retained-human", base: null,
    fields: { ...learning.rewardAuthoringFields(null, null), name: "Owner rubric", kind: "human",
      rubric: human.rubric, reviewerRole: "owner" } });
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "human-binding", revision: 1,
    sources: [{ graderId: retained.reward.id, reward: learning.learningRef(retained.reward), role: "evaluation",
      normalization: { kind: "identity" }, weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }],
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [retained.reward]);
  const projected = projectLearningBatchGraders(binding, [retained.reward], retained.assets);
  const roundTrip = compile(TasksetDraftSchema.parse({ ...ready, graders: projected }));
  expect(roundTrip.taskset.graders).toEqual(compileBoundGraders(binding, [retained.reward]));
  const automated = { ...human, id: "automated", kind: "content", config: { match: "exact", expected: "answer" } };
  // Publication retains authored graders; scored execution enforces calibration.
  const mixed = compile(TasksetDraftSchema.parse({ ...ready, graders: [human, automated] }));
  const { validateTaskset } = await import("../src/taskset-authored-validation.js");
  expect(mixed.taskset.graders).toHaveLength(2);
  const { publishTasksetDraft } = await import("../src/taskset-draft-publication.js");
  const authored = publishTasksetDraft({ draft: { ...ready, graders: [human, automated] }, now });
  expect(validateTaskset(authored).issues.some(issue => issue.code === "grader_fixtures_required")).toBe(true);
});
