import { expect, it } from "vitest";
import { createJavaScriptEnvironmentSession } from "@openpond/evals/javascript-environment";
import { executeJavaScriptEnvironmentInWorker } from "@openpond/evals/javascript-environment/node";
import { prepareImportedTasksetPackage, prepareModelTasksetDraft, prepareTasksetDraftSource, materializeTasksetDraftWorkspace, compileModelTasksetDraftWorkspace, resolveTasksetPackageExecution } from "../src/taskset-packages.js";
import { tasksetDraftFromTaskset, saveTasksetDraftWorkspaceDocument, saveTasksetDraftWorkspaceFile, readTasksetDraftWorkspaceFile } from "../src/taskset-drafts.js";
import { ordinaryToolTaskset } from "./fixtures/ordinary-tool-taskset.js";

// Hosted snapshots must compile through the same authoring engine as local
// files, execute changed private code and retain the exact previous revision.
it("opens, edits and compiles ordinary source snapshots without changing earlier execution", async () => {
  const source = ordinaryToolTaskset();
  const now = "2026-09-08T12:00:00.000Z";
  const owner = { scopeId: "workspace", modelId: "world-model" };
  const preparation = prepareModelTasksetDraft({ owner, source, request: { schemaVersion: "openpond.modelTasksetDraftRequest.v1",
    operationId: "open-world", modelId: owner.modelId, expectedModelRevision: 1, sourcePackageHash: source.contentHash } });
  const projected = prepareImportedTasksetPackage({ package: source, profileId: owner.scopeId, name: "World", createdAt: now });
  const initialized = prepareTasksetDraftSource({ source, preparation, expectedModelRevision: 1, sourceDraft: tasksetDraftFromTaskset(projected.taskset, now) });
  let workspace = materializeTasksetDraftWorkspace({ initialized, source });
  const originalWorkspace = workspace;
  workspace = saveTasksetDraftWorkspaceDocument({ workspace, expectedDraftRevision: 1, now, draft: { ...workspace.draft, objective: "Inspect and report the public value." } });
  expect(() => compileModelTasksetDraftWorkspace({ workspace, preparation, now, adapterId: "test-private-environment" })).toThrow(/secret|licensing|PII/);
  // This fixture explicitly reviews its synthetic source; import itself never
  // grants that review or makes a draft an active learning input.
  workspace = saveTasksetDraftWorkspaceDocument({ workspace, expectedDraftRevision: 2, now, draft: { ...workspace.draft,
    sourceRefs: workspace.draft.sourceRefs.map(ref => ({ ...ref, licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed" })),
    tasks: workspace.draft.tasks.map(task => ({ ...task, expectedOutput: { text: "2" } })),
  } });
  const path = "environment/world.js";
  const read = readTasksetDraftWorkspaceFile(workspace, path);
  workspace = saveTasksetDraftWorkspaceFile({ workspace, now, mutation: { draftId: workspace.draft.id, expectedDraftRevision: workspace.draft.revision,
    path, expectedFileHash: read.file.contentHash, content: { encoding: "utf8", data: read.file.content.data.replace("value: 1", "value: 2") } } });
  const compiled = compileModelTasksetDraftWorkspace({ workspace, preparation, now, adapterId: "test-private-environment" });
  expect(compiled.taskset.id).toBe(preparation.tasksetId);
  expect(compiled.taskset.revision).toBe(1);
  expect(compiled.taskset.tasks[0]!.expectedOutput).toEqual({ text: "2" });
  expect(compileModelTasksetDraftWorkspace({ workspace, preparation, now: "2026-09-09T12:00:00.000Z", adapterId: "test-private-environment" })).toEqual(compiled);
  const privateState = source.files.find(file => file.asset.path === "environment/state.json")!;
  expect(compiled.files.find(file => file.asset.id === privateState.asset.id)).toEqual(privateState);
  expect(readTasksetDraftWorkspaceFile(originalWorkspace, path).file.content.data).toContain("value: 1");
  expect(() => compileModelTasksetDraftWorkspace({ workspace, preparation: { ...preparation, tasksetId: "forged" }, now, adapterId: "test-private-environment" })).toThrow("retained source");
  async function inspect(value: typeof source) {
    const execution = resolveTasksetPackageExecution(value)!;
    const session = await createJavaScriptEnvironmentSession({ definition: execution.execution.javascript,
      asset: execution.assets.find(asset => asset.id === execution.execution.javascript.module.id)!,
      initialState: JSON.parse(execution.assets.find(asset => asset.id === value.taskset.tasks[0]!.privilegedContextRef)!.text),
      input: value.taskset.tasks[0]!.input, seed: 17, execute: executeJavaScriptEnvironmentInWorker });
    try { return await session.step({ name: "inspect", arguments: {} }); }
    finally { await session.destroy(); }
  }
  expect(await inspect(compiled)).toEqual({ value: 2 });
  expect(await inspect(source)).toEqual({ value: 1 });
  const next = prepareModelTasksetDraft({ owner, source: compiled, request: { schemaVersion: "openpond.modelTasksetDraftRequest.v1",
    operationId: "reopen-world", modelId: owner.modelId, expectedModelRevision: 2, sourcePackageHash: compiled.contentHash } });
  expect(next.tasksetId).toBe(compiled.taskset.id);
  expect(next.tasksetRevision).toBe(2);
  const reopened = prepareImportedTasksetPackage({ package: compiled, profileId: owner.scopeId, name: "World", createdAt: now });
  const nextWorkspace = materializeTasksetDraftWorkspace({ source: compiled, initialized: prepareTasksetDraftSource({ source: compiled, preparation: next,
    expectedModelRevision: 2, sourceDraft: tasksetDraftFromTaskset(reopened.taskset, now) }) });
  expect(readTasksetDraftWorkspaceFile(nextWorkspace, path).file.content.data).toContain("value: 2");
  expect(nextWorkspace.files.some(file => file.path.startsWith("source-artifacts/"))).toBe(true);
});
