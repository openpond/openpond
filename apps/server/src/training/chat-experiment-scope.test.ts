import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionSchema, TurnSchema, type ChatResourceSummary } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { chatExperimentContext, createChatExperimentScopes } from "./chat-experiment-scope.js";

const dataset = (revision: number): ChatResourceSummary => ({ kind: "dataset", id: "examples", revision, name: "Examples", state: "Draft", rows: [] });

// Failure story: a delayed completion or replay must not replace newer user
// inputs; concurrent scope creation must survive restart without duplicate IDs.
test("chat scopes retain immutable runs, serialized selections and originating-turn ownership across restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-chat-scopes-"));
  let store = new SqliteStore(home);
  try {
    for (const id of ["chat-a", "chat-b"]) await store.insertSessionAtFront(SessionSchema.parse({
      id, provider: "codex", title: id, appId: null, appName: null, cwd: null, codexThreadId: null, pinned: false, archived: false, order: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", status: "idle",
    }));
    let scopes = createChatExperimentScopes(store);
    await Promise.all([scopes.create("chat-a", "create-a"), scopes.create("chat-a", "create-b")]);
    let state = chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    expect(state.scopes.map(scope => scope.ordinal)).toEqual([1, 2]);
    const first = state.scopes[0]!;
    const selected=await scopes.select("chat-a", { scopeId: first.id, dataset: dataset(1),operationId:"visual-selection",visualPublicationId:"publication" });
    const replay=await scopes.select("chat-a", { scopeId: first.id, dataset: dataset(1),operationId:"visual-selection",visualPublicationId:"publication",expectedSelectionVersion:0 });
    expect(replay.selectionVersion).toBe(selected.selectionVersion);
    await expect(scopes.select("chat-a", { scopeId:first.id,dataset:dataset(2),operationId:"visual-selection",visualPublicationId:"publication" })).rejects.toThrow("reused");
    await store.insertTurn(TurnSchema.parse({ id: "run-turn", sessionId: "chat-a", prompt: "Run", providerTurnId: null,
      startedAt: "2026-10-01T00:01:00.000Z", completedAt: null, status: "in_progress", error: null,
      metadata: { chatExperimentScopeId: first.id, chatExperimentSelectionVersion: selected.selectionVersion } }));
    const run: ChatResourceSummary = { kind: "experiment", id: "run-one", revision: 1, name: "Saved run", state: "Running", datasetId: "examples", datasetRevision: 1, rows: [] };
    await scopes.attach("chat-a", "run-turn", run);
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[0]!.selectedRunId).toBe(run.id);
    // A same-turn dataset update and delayed result must not label the old run
    // with the updated draft's inputs, even without a selection-version change.
    await scopes.attach("chat-a", "run-turn", dataset(2));
    await scopes.attach("chat-a", "run-turn", { ...run, state: "Completed" });
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[0]!.selectedRunId).toBeNull();
    await scopes.select("chat-a", { scopeId: first.id, dataset: dataset(2) });
    await scopes.attach("chat-a", "run-turn", dataset(1));
    await scopes.attach("chat-a", "run-turn", { ...run, state: "Completed" });
    await scopes.attach("chat-a", "run-turn", { kind: "grader", id: "grader-one", revision: 2, name: "Exact", state: "Checked", datasetId: "examples", datasetRevision: 2,
      rows: [{ id: "private-fixture", label: "Known good", detail: "private expected answer" }] });
    state = chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    expect(state.scopes[0]!.dataset?.revision).toBe(2);
    expect(state.scopes[0]!.selectedRunId).toBeNull();
    expect(state.scopes[0]!.runs).toEqual([{ ...run, state: "Completed" }]);
    expect(state.scopes[0]!.graders[0]!.rows).toEqual([]);
    await expect(scopes.attach("chat-b", "run-turn", run)).rejects.toThrow("does not belong");
    await expect(scopes.select("chat-b", { scopeId: first.id })).rejects.toThrow("does not belong");
    await expect(scopes.select("chat-a", { dataset: dataset(1), expectedSelectionVersion: 0 })).rejects.toThrow("changed");
    const second = state.scopes[1]!;
    await scopes.select("chat-a", { scopeId: second.id });
    await expect(scopes.select("chat-a", { scopeId:first.id,dataset:dataset(1),operationId:"visual-selection",visualPublicationId:"publication" })).rejects.toThrow("newer");
    await scopes.create("chat-a", "create-a");
    await scopes.attach("chat-a", "run-turn", { ...run, state: "Completed" });
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).activeScopeId).toBe(second.id);
    await store.close();
    store = new SqliteStore(home); scopes = createChatExperimentScopes(store);
    await scopes.create("chat-a", "create-a");
    state = chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    expect(state.scopes).toHaveLength(2);
    expect(state.activeScopeId).toBe(second.id);
    expect(state.scopes[0]!.runs[0]!.datasetRevision).toBe(1);
    expect(chatExperimentContext((await store.getSession("chat-b"))?.metadata).scopes).toEqual([]);
  } finally { await store.close(); await rm(home, { recursive: true, force: true }); }
});
