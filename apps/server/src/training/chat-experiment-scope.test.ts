import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionSchema, TurnSchema, chatTrainingReference, type ChatTrainingAttachment, type ChatResourceSummary } from "@openpond/contracts";
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
    // Concurrent discovery must open dataset focus without allocating experiments,
    // and subsequent discovery must preserve the user's selection.
    await Promise.all([scopes.ensure("chat-b"), scopes.ensure("chat-b")]);
    const discovered = chatExperimentContext((await store.getSession("chat-b"))?.metadata);
    expect(discovered.scopes).toHaveLength(0);
    expect(discovered.datasetFocus?.dataset).toBeNull();
    expect(discovered.activeScopeId).toBe(discovered.datasetFocus!.id);
    const focused = await scopes.select("chat-b", { dataset: dataset(1), evaluationModel:"codex/model-a", executionLocation:"cloud" });
    expect(await scopes.ensure("chat-b")).toEqual(focused);
    expect(focused.scopes).toHaveLength(0);
    store.close();
    store = new SqliteStore(home);
    scopes = createChatExperimentScopes(store);
    expect(chatExperimentContext((await store.getSession("chat-b"))?.metadata).datasetFocus?.dataset?.id).toBe("examples");
    await expect(scopes.create("chat-b", "invalid-grader", focused.selectionVersion, "missing")).rejects.toThrow("Grader does not belong");
    const setupGrader: ChatResourceSummary = {kind:"grader", id:"setup-grader", revision:1, name:"Exact", state:"Ready", datasetId:"examples", datasetRevision:1, rows:[]};
    await expect(scopes.create("chat-b", "stale-grader", focused.selectionVersion, setupGrader.id, [{...setupGrader,datasetRevision:2}])).rejects.toThrow("Dataset changed");
    const promoted = await scopes.create("chat-b", "explicit-experiment", focused.selectionVersion, setupGrader.id, [setupGrader]);
    expect(promoted.scopes[0]?.selectedGraderId).toBe(setupGrader.id);
    expect(promoted.scopes[0]?.evaluationModel).toBe("codex/model-a");
    expect(promoted.scopes[0]?.executionLocation).toBe("cloud");
    expect(promoted.scopes[0]?.ordinal).toBe(1);
    expect(promoted.scopes[0]?.dataset?.id).toBe("examples");
    expect(promoted.datasetFocus).toBeUndefined();
    expect(promoted.selectionVersion).toBe(focused.selectionVersion + 1);
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
    const run: ChatResourceSummary = { kind: "experiment", id: "run-one", revision: 1, name: "Saved run", state: "Running", model:"codex/model-a", datasetId: "examples", datasetRevision: 1, rows: [] };
    await scopes.attach("chat-a", "run-turn", run);
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[0]!.selectedRunId).toBe(run.id);
    // A same-turn dataset update and delayed result must not label the old run
    // with the updated draft's inputs, even without a selection-version change.
    await scopes.attach("chat-a", "run-turn", dataset(2));
    await scopes.attach("chat-a", "run-turn", { ...run, state: "Completed" });
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[0]!.selectedRunId).toBeNull();
    await scopes.select("chat-a", { scopeId: first.id, dataset: dataset(2), evaluationModel:"codex/model-b" });
    await scopes.attach("chat-a", "run-turn", dataset(1));
    await scopes.attach("chat-a", "run-turn", { ...run, state: "Completed" });
    await scopes.attach("chat-a", "run-turn", { kind: "grader", id: "grader-one", revision: 2, name: "Exact", state: "Checked", datasetId: "examples", datasetRevision: 2,
      rows: [{ id: "private-fixture", label: "Known good", detail: "private expected answer" }] });
    state = chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    expect(state.scopes[0]!.dataset?.revision).toBe(2);
    expect(state.scopes[0]!.evaluationModel).toBe("codex/model-b");
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
    await store.insertTurn(TurnSchema.parse({ id:"owner-turn",sessionId:"chat-b",prompt:"Inspect",providerTurnId:null,
      startedAt:new Date().toISOString(),completedAt:null,status:"in_progress",error:null,metadata:{} }));
    const ownerA={teamId:"team-a",actorId:"actor-a"},ownerB={teamId:"team-b",actorId:"actor-b"};
    await scopes.attach("chat-b","owner-turn",{...dataset(1),owner:ownerA});
    await scopes.attach("chat-b","owner-turn",{...run,owner:ownerB});
    await scopes.attach("chat-b","owner-turn",{kind:"grader",id:"foreign-grader",revision:1,name:"Foreign",state:"Pinned",datasetId:"examples",datasetRevision:1,owner:ownerB,rows:[]});
    const ownedScope=chatExperimentContext((await store.getSession("chat-b"))?.metadata).scopes[0]!;
    expect(ownedScope.selectedRunId).toBeNull();expect(ownedScope.graders).toEqual([]);
    // One conversational turn can address two experiments. The second explicit
    // selection must not be overridden by the first scope's turn history.
    await store.updateTurn("run-turn", current => ({...current, metadata:{...current.metadata,chatExperimentScopeId:second.id}}));
    await scopes.attach("chat-a", "run-turn", {...run,id:"second-run"});
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[1]!.runs.map(run=>run.id)).toContain("second-run");
    await store.updateTurn("run-turn", current => ({...current, metadata:{chatResourceContexts:[
      {scopeId:first.id,selectionVersion:0,resources:[{kind:"dataset",id:"examples",revision:1}]},
      {scopeId:second.id,selectionVersion:0,resources:[{kind:"dataset",id:"other",revision:1}]},
    ]}}));
    await scopes.attach("chat-a", "run-turn", {...run,id:"matched-run",datasetId:"other"});
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[1]!.runs.map(run=>run.id)).toContain("matched-run");
    await expect(scopes.attach("chat-a", "run-turn", {...run,id:"unmatched-run",datasetId:"unknown"})).rejects.toThrow("Select the intended experiment scope");
    const training: ChatTrainingAttachment = {location:"local",jobId:"training-job",modelRunId:"training-run",modelId:"model",modelVersionId:null,
      adapterArtifactLineageId:null,owner:ownerA,taskset:{id:"published-training-data",revision:1,contentHash:"a".repeat(64)},
      state:"running",executionState:"running",updatedAt:"2026-10-13T00:00:00.000Z"};
    await expect(scopes.attachTraining("chat-a","run-turn",training)).rejects.toThrow("multiple targets");
    await store.updateTurn("run-turn",current=>({...current,metadata:{chatResourceContexts:[
      {scopeId:first.id,selectionVersion:0,resources:[],training:[chatTrainingReference(training)]},
      {scopeId:second.id,selectionVersion:0,resources:[],training:[chatTrainingReference({...training,jobId:"other-job",modelRunId:"other-run"})]},
    ]}}));
    await scopes.attachTraining("chat-a","run-turn",training);
    expect(chatExperimentContext((await store.getSession("chat-a"))?.metadata).scopes[0]!.training).toEqual([training]);
    await store.updateTurn("run-turn",current=>({...current,metadata:{chatExperimentScopeId:first.id,chatExperimentSelectionVersion:0}}));
    await scopes.attachTraining("chat-a","run-turn",training);
    await scopes.attachTraining("chat-a","run-turn",training);
    await scopes.attachTraining("chat-a","run-turn",{...training,state:"prepared",updatedAt:"2026-10-12T00:00:00.000Z"});
    await expect(scopes.attachTraining("chat-b","run-turn",training)).rejects.toThrow("does not belong");
    await store.close();
    store = new SqliteStore(home); scopes = createChatExperimentScopes(store);
    await scopes.create("chat-a", "create-a");
    state = chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    expect(state.scopes).toHaveLength(2);
    expect(state.scopes[0]!.training).toEqual([training]);
    expect(state.scopes[0]!.dataset?.revision).toBe(2);
    expect(state.scopes[0]!.evaluationModel).toBe("codex/model-b");
    expect(state.scopes[0]!.selectedTrainingKey).toBeUndefined();
    expect(state.activeScopeId).toBe(second.id);
    expect(state.scopes[0]!.runs[0]!.datasetRevision).toBe(1);
    expect(chatExperimentContext((await store.getSession("chat-b"))?.metadata).scopes[0]!.dataset?.owner).toEqual(ownerA);
  } finally { await store.close(); await rm(home, { recursive: true, force: true }); }
});
