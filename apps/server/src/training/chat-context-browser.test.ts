import { createServer } from "node:http";
import { once } from "node:events";
import { canonicalSha256, canonicalJson, OPENPOND_TRAINING_MEDIA_TYPE, type ExperimentDraftRecord, type ExperimentDraftReceipt } from "openpond-sdk/training";
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
import { createModelTrainingRecipeDefaults } from "openpond-sdk/model-starters";

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

// Failure story: chat metadata becomes a second mutable owner, or a late save
// replays into another scope/account. Exercise actual HTTP plus reopened SQLite;
// the fixture is a protocol peer, not proof of the hosted Postgres transaction.
test("links chat drafts to canonical storage across save, reopen, retry and focus changes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-stored-chat-draft-"));
  let store = new SqliteStore(home);
  const time = "2026-10-31T00:00:00.000Z";
  const records = new Map<string, ExperimentDraftRecord>(), receipts = new Map<string, ExperimentDraftReceipt>();
  let mutations = 0, pauseList = false;
  let releaseList!: () => void, observeList!: () => void;
  const listPaused = new Promise<void>(resolve => { observeList = resolve; });
  const listReleased = new Promise<void>(resolve => { releaseList = resolve; });
  const server = createServer(async (request, response) => {
    const reply = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": OPENPOND_TRAINING_MEDIA_TYPE }); response.end(JSON.stringify(value)); };
    try {
      expect(request.headers.authorization).toBe("Bearer draft-fixture");
      const url = new URL(request.url!, "http://localhost");
      expect(url.pathname.startsWith("/v1/training/experiment-drafts")).toBe(true);
      if (pauseList && url.pathname === "/v1/training/experiment-drafts" && request.method === "GET") { observeList(); await listReleased; }
      if (request.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString()), requestHash = await canonicalSha256(input);
        const prior = receipts.get(input.operationId);
        if (prior) { reply(prior.requestHash === requestHash ? prior : { message: "Operation reused with different settings." }, prior.requestHash === requestHash ? 200 : 409); return; }
        const previous = records.get(input.draft.id);
        if ((previous?.revision ?? 0) !== input.expectedRevision) { reply({ message: "Newer draft revision." }, 409); return; }
        const content = { schemaVersion: "openpond.experimentDraftRecord.v1" as const, id: input.draft.id,
          teamId: "team", ownerUserId: "actor", projectId: input.projectId, revision: input.expectedRevision + 1,
          status: "draft" as const, draft: input.draft, createdAt: previous?.createdAt ?? time, updatedAt: time };
        const record = { ...content, contentHash: await canonicalSha256(content) };
        const receipt = { schemaVersion: "openpond.experimentDraftReceipt.v1" as const, operationId: input.operationId, requestHash, record };
        records.set(record.id, record); receipts.set(input.operationId, receipt); mutations++; reply(receipt); return;
      }
      expect(url.searchParams.get("teamId")).toBe("team");
      const id = decodeURIComponent(url.pathname.slice("/v1/training/experiment-drafts/".length));
      if (url.pathname === "/v1/training/experiment-drafts") reply({ schemaVersion: "openpond.experimentDraftPage.v1",
        teamId: "team", ownerUserId: "actor", projectId: null, items: [...records.values()], nextCursor: null });
      else reply(records.get(id));
    } catch (error) { reply({ message: String(error) }, 500); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected HTTP listener.");
  const access = { apiBaseUrl: `http://127.0.0.1:${address.port}`, token: "draft-fixture", teamId: "team", actorId: "actor" };
  const draft = { schemaVersion: "openpond.experimentDraft.v1" as const, id: "training-draft", operationType: "sft" as const,
    name: "SFT experiment", training: { maximumSpendUsd: 2,
      baseModel: { schemaVersion: "openpond.baseModelPreference.v1" as const, modelId: "example/model", revision: "pinned-model",
        tokenizerRevision: "pinned-tokenizer", chatTemplateHash: null, modelAssetId: null, source: "managed" as const } } };
  const target = { kind: "experiment" as const, id: draft.id, location: "local" as const, draft };
  const makeBrowser = () => {
    const scopes = createChatExperimentScopes(store);
    return createChatContextBrowser({ store, access: async () => access,
      resources: async () => [], resource: async () => { throw new Error("A draft is not an execution or dataset."); },
      createExperiment: async () => { throw new Error("Do not create a dataset-backed experiment."); },
      createDraft: async (id, input, expected) => { await scopes.createDraft(id, input, expected); },
      linkStoredDraft: async (id, record, reference, expected, scopeId) => { await scopes.linkStoredDraft(id, record, reference, expected, scopeId); },
      selectResource: async (id, ref) => { await scopes.select(id, { scopeId: ref?.scopeId }); },
    });
  };
  try {
    const staged = await makeBrowser().select(target, undefined, true);
    expect(staged).toMatchObject({ target, draft });
    expect(await store.sessionShells()).toEqual([]); expect(mutations).toBe(0);
    const create = { schemaVersion: "openpond.experimentDraftSave.v1", teamId: "team", projectId: null,
      operationId: "save-before-first-message", expectedRevision: 0, draft };
    const savedBeforeChat = await makeBrowser().updateDraft(undefined, target, create);
    expect(savedBeforeChat.saved.storedDraft?.revision).toBe(1);
    expect(await store.sessionShells()).toEqual([]);
    expect((await makeBrowser().catalog(false)).options.some(option => option.target.storedDraft && option.target.id === draft.id)).toBe(true);
    const savedTarget = savedBeforeChat.saved.target;
    await store.insertSessionAtFront(SessionSchema.parse({ id: "chat", provider: "codex", title: "Chat", appId: null, appName: null,
      cwd: null, codexThreadId: null, pinned: false, archived: false, order: 0, createdAt: time, updatedAt: time, status: "idle",
      metadata: { chatContextSelection: savedTarget } }));
    const attached = await makeBrowser().current("chat");
    expect(attached).toMatchObject({ draft, storedDraft: { revision: 1 }, target: { scopeId: expect.any(String), sessionId: "chat" } });
    expect(attached?.resource).toBeUndefined();
    let state = chatExperimentContext((await store.getSession("chat"))?.metadata);
    expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0].storedDraft).toMatchObject({ id: draft.id, teamId: "team", apiOrigin: access.apiBaseUrl });
    const version = state.selectionVersion;
    await makeBrowser().select(savedTarget, "chat", true);
    expect(chatExperimentContext((await store.getSession("chat"))?.metadata).selectionVersion).toBe(version);
    const next = { schemaVersion: "openpond.experimentDraft.v1" as const, id: "blank-evaluation", operationType: "evaluate" as const, name: "Evaluation" };
    const newer = await makeBrowser().select({ kind: "experiment", id: next.id, location: "local", draft: next }, "chat", true);
    await makeBrowser().select(savedTarget, "chat", true);
    expect((await makeBrowser().current("chat"))?.draft).toEqual(next);
    await makeBrowser().select(attached!.target, "chat");
    const form = { baseModel: draft.training.baseModel, recipe: createModelTrainingRecipeDefaults(null, "sft"),
      batch: null, evaluation: null, validationSplit: "validation" as const, name: "", budget: "" };
    const edited = { ...draft, trainingForm: form };
    const update = { ...create, operationId: "save-empty-fields", expectedRevision: 1, draft: edited };
    const saved = await makeBrowser().updateDraft("chat", attached!.target, update);
    expect(saved.saved).toMatchObject({ draft: { trainingForm: { name: "", budget: "" } }, storedDraft: { revision: 2 } });
    await expect(makeBrowser().updateDraft("chat", attached!.target, { ...update, draft: { ...edited, name: "Different save" } })).rejects.toThrow();
    const writes = await Promise.allSettled(["first", "second"].map(name => makeBrowser().updateDraft("chat", attached!.target,
      { ...update, operationId: `save-${name}`, expectedRevision: 2, draft: { ...edited, name } })));
    expect(writes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const latest = await makeBrowser().current("chat");
    expect(latest?.storedDraft?.revision).toBe(3);
    const oldRetry = await makeBrowser().updateDraft("chat", attached!.target, update);
    expect(oldRetry.saved).toEqual(saved.saved);
    expect(oldRetry.currentSaved).toEqual(latest);
    store.close(); store = new SqliteStore(home);
    expect(await makeBrowser().current("chat")).toEqual(latest);
    // A canonical edit outside this chat is visible after reopen, not replaced
    // with the older retained metadata snapshot.
    const external = { ...records.get(draft.id)!, revision: 4, draft: { ...edited, name: "Edited outside chat" } };
    const { contentHash: _old, ...content } = external;
    records.set(draft.id, { ...content, contentHash: await canonicalSha256(content) });
    expect((await makeBrowser().current("chat"))?.draft?.name).toBe("Edited outside chat");
    await makeBrowser().select(newer!.target, "chat");
    const inactive = await makeBrowser().updateDraft("chat", attached!.target, { ...update, operationId: "save-inactive", expectedRevision: 4 });
    expect(inactive.saved.storedDraft?.revision).toBe(5);
    expect(inactive.selection?.draft).toEqual(next);
    await expect(makeBrowser().updateDraft("another-chat", attached!.target, update)).rejects.toThrow("another chat");
    access.teamId = "another-team";
    await expect(makeBrowser().resolve(attached!.target)).rejects.toThrow("another workspace");
    access.teamId = "team"; access.actorId = "another-actor";
    await expect(makeBrowser().resolve(attached!.target)).rejects.toThrow("another account");
    access.actorId = "actor";
    pauseList = true;
    const oldAccountCatalog = makeBrowser().catalog(false);
    await listPaused; access.teamId = "another-team"; releaseList();
    expect((await oldAccountCatalog).options.some(option => option.target.storedDraft)).toBe(false);
    expect(canonicalJson(chatExperimentContext((await store.getSession("chat"))?.metadata).scopes.map(scope => scope.runs))).toBe("[[],[]]");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(home, { recursive: true, force: true });
  }
});
