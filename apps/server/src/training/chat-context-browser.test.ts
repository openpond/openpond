import { expect, test, vi } from "vitest";
import { SqliteStore } from "../store/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionSchema, TurnSchema } from "@openpond/contracts";
import { createChatExperimentScopes, chatExperimentContext } from "./chat-experiment-scope.js";
vi.mock("./hosted-model-project-catalog.js", () => ({
  listHostedModelProjectCatalog: async () => ({ projects: [{ project: { id: "model", portableProjectId: "portable", name: "Test model", defaultBaseModel: null, trainingSetup: { tasksetRef: null, evaluationTasksetRef: null } } }] }),
}));
import { createChatContextBrowser } from "./chat-context-browser.js";

// A selection carries identity into a new chat; its saved display snapshot must
// never become status authority or bypass the account that owns the job.
test("retains an exact training target and reauthorizes it for fresh status reads", async () => {
  const access = { apiBaseUrl: "https://api.example.test", token: "test", teamId: "team", actorId: "actor" };
  let state = "running";
  let metadata: Record<string, unknown> = {};
  const request = vi.fn(async () => new Response(JSON.stringify({ job: {
    schemaVersion: "openpond.trainingJob.v2", id: "job", teamId: "team", kind: "policy_optimize",
    modelProjectId: "model", portableProjectId: "portable", sourceProjectRevision: 1, submissionHash: "a".repeat(64),
    state, phase: state === "running" ? "training" : "completed", version: 1, progress: state === "running" ? 0.5 : 1,
    rolloutProgress: { groupsCompleted: 1, groupsTarget: 1, optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 0 },
    accruedSpendUsd: 1, terminalReason: null, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T01:00:00.000Z", completedAt: null,
  } })));
  vi.stubGlobal("fetch", request);
  try {
    const store = { getSession: async () => ({ id: "chat", metadata }), updateSession: async (_id: string, update: (value: unknown) => { metadata: Record<string, unknown> }) => {
      const result = update({ id: "chat", metadata }); metadata = result.metadata; return result;
    } } as unknown as SqliteStore;
    const browser = createChatContextBrowser({ store, access: async () => access, resources: async () => [], resource: async () => { throw new Error("unused"); }, selectResource: async () => {}, createExperiment: async () => {} });
    const target = { kind: "training", id: "job", location: "cloud", teamId: "team", apiOrigin: access.apiBaseUrl };
    const selected = await browser.select(target, "chat");
    expect(selected?.training).toMatchObject({ jobId: "job", job: { state: "running" } });
    expect(metadata).toMatchObject({ chatContextSelection: target, chatContextSelectionVersion: 0 });
    state = "succeeded";
    delete metadata.chatContextSelectionVersion;
    expect((await browser.current("chat"))?.training).toMatchObject({ job: { state: "succeeded" } });
    expect(metadata.chatContextSelectionVersion).toBe(0);
    expect((await browser.resolve(metadata.chatContextSelection)).training).toMatchObject({ job: { state: "succeeded" } });
    const calls = request.mock.calls.length;
    await expect(browser.resolve({ ...target, teamId: "different" })).rejects.toThrow("account");
    expect(request).toHaveBeenCalledTimes(calls);
    expect(metadata).toMatchObject({ chatContextSelection: target, chatContextSelectionVersion: 0 });
  } finally { vi.unstubAllGlobals(); }
});

// Failure story: a tool changes the active experiment after a picker selection.
// Returning the saved picker target would silently attach the wrong run to the next question.
test("detects chat-driven experiment changes while retaining exact dataset revision pins", async () => {
  const old = { kind: "experiment" as const, id: "old", revision: 1, location: "local" as const };
  const dataset = { kind: "dataset" as const, id: "dataset", revision: 2, name: "Dataset", state: "Ready", rows: [] };
  const run = { kind: "experiment" as const, id: "new", revision: 1, name: "New experiment", state: "completed", datasetId: "dataset", datasetRevision: 2, location: "local" as const, rows: [] };
  const time = "2026-10-14T00:00:00.000Z";
  const scope = { id: "scope", ordinal: 1, name: "Experiment 1", dataset, graders: [], selectedGraderId: null, runs: [run], selectedRunId: run.id, turnIds: [], operationId: "create", createdAt: time, updatedAt: time };
  const metadata: Record<string, unknown> = { chatContextSelection: old, chatContextSelectionVersion: 1, chatExperimentContext: { scopes: [scope], activeScopeId: scope.id, selectionVersion: 2, selectedAt: time, selectionOperations: {} } };
  const apply = vi.fn();
  const browser = createChatContextBrowser({
    store: { getSession: async () => ({ id: "chat", metadata }), listModelProjects: async () => [{ id: "model", name: "Test model", defaultBaseModel: null }], getModelProject: async () => ({ id: "model", name: "Test model", defaultBaseModel: null, trainingSetup: { tasksetRef: null, evaluationTasksetRef: null } }) } as unknown as SqliteStore,
    access: async () => ({ apiBaseUrl: "https://api.example.test", token: "test", teamId: "team", actorId: "actor" }),
    resources: async () => [run, dataset], resource: async () => run, selectResource: apply, createExperiment: async () => {},
    inspectResource: async () => ({ dataset, graders: [] }),
  });
  expect(await browser.current("chat")).toMatchObject({ target: { id: "new", kind: "experiment" }, dataset: { id: "dataset", revision: 2 } });
  expect(apply).not.toHaveBeenCalled();
  metadata.chatContextSelection = { ...old, id: "model", kind: "model" };
  metadata.chatContextSelectionVersion = 2;
  expect((await browser.current("chat"))?.model?.name).toBe("Test model");
});

// A new experiment using the same dataset must not display or inherit the previous run.
test("creates and reselects an independent experiment draft on the same dataset", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-picker-draft-"));
  const store = new SqliteStore(home);
  try {
    const time = "2026-10-14T00:00:00.000Z";
    await store.insertSessionAtFront(SessionSchema.parse({ id: "chat", provider: "codex", title: "Chat", appId: null, appName: null,
      cwd: null, codexThreadId: null, pinned: false, archived: false, order: 0, createdAt: time, updatedAt: time, status: "idle" }));
    const dataset = { kind: "dataset" as const, id: "dataset", revision: 2, name: "Examples", state: "Ready", rows: [] };
    const oldRun = { kind: "experiment" as const, id: "old-run", revision: 1, name: "Old run", state: "completed", datasetId: dataset.id, datasetRevision: 2, rows: [] };
    const newRun = { ...oldRun, id: "new-run", name: "New run" };
    const scopes = createChatExperimentScopes(store);
    await scopes.select("chat", { dataset, run: oldRun });
    const original = chatExperimentContext((await store.getSession("chat"))?.metadata).activeScopeId;
    const browser = createChatContextBrowser({ store,
      access: async () => ({ apiBaseUrl: "https://api.example.test", token: "test", teamId: "team", actorId: "actor" }),
      resources: async () => [dataset, oldRun], resource: async target => target.kind === "experiment" ? target.id === newRun.id ? newRun : oldRun : dataset, inspectResource: async () => ({ dataset, graders: [] }),
      createExperiment: async sessionId => {
        await scopes.createForDataset(sessionId, { dataset, graders: [], operationId: "new-draft" });
      },
      selectResource: async (sessionId, target) => { await scopes.select(sessionId, target?.scopeId ? { scopeId: target.scopeId } : { dataset }); },
    });
    const draft = await browser.select({ kind: "dataset", id: dataset.id, revision: 2, location: "local" }, "chat", true);
    expect(draft?.target).toMatchObject({ kind: "experiment", sessionId: "chat" });
    expect(draft?.target.scopeId).not.toBe(original);
    let state = chatExperimentContext((await store.getSession("chat"))?.metadata);
    expect(state.scopes.find(scope => scope.id === original)?.runs).toEqual([oldRun]);
    expect(state.scopes.find(scope => scope.id === draft!.target.scopeId)?.runs).toEqual([]);
    await scopes.select("chat", { scopeId: original! });
    expect((await browser.current("chat"))?.target.id).toBe(oldRun.id);
    await browser.select(draft!.target, "chat");
    expect((await browser.current("chat"))?.target.scopeId).toBe(draft!.target.scopeId);
    state = chatExperimentContext((await store.getSession("chat"))?.metadata);
    expect(state.activeScopeId).toBe(draft!.target.scopeId);
    // Attaching execution evidence does not increment the explicit selection version.
    // The picker must still discover the newly selected run in the active draft.
    await store.insertTurn(TurnSchema.parse({ id: "turn", sessionId: "chat", prompt: "Evaluate", providerTurnId: null,
      startedAt: time, completedAt: null, status: "in_progress", error: null,
      metadata: { chatExperimentScopeId: draft!.target.scopeId, chatExperimentSelectionVersion: state.selectionVersion } }));
    await scopes.attach("chat", "turn", newRun);
    const attached = chatExperimentContext((await store.getSession("chat"))?.metadata);
    expect(attached.selectionVersion).toBe(state.selectionVersion);
    expect((await browser.current("chat"))?.target.id).toBe(newRun.id);
    // A delayed new-chat initializer cannot override a newer top-level model choice,
    // even if the scope selection counter did not change during that choice.
    const oldTarget = { kind: "dataset" as const, id: dataset.id, revision: dataset.revision, location: "local" as const };
    await store.updateSession("chat", session => ({ ...session, metadata: { ...session.metadata,
      chatContextSelection: { kind: "model", id: "model", location: "local" } } }));
    await expect(scopes.createForDataset("chat", { dataset, graders: [], operationId: "delayed", expected: { version: attached.selectionVersion, target: oldTarget } })).rejects.toThrow();
    expect(chatExperimentContext((await store.getSession("chat"))?.metadata).scopes).toHaveLength(attached.scopes.length);


  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});
