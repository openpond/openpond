import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionSchema, TurnSchema, chatTrainingReference, type ChatTrainingAttachment, type ChatResourceSummary } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { chatExperimentContext, createChatExperimentScopes } from "./chat-experiment-scope.js";

const dataset = (revision: number): ChatResourceSummary => ({ kind: "dataset", id: "examples", revision, name: "Examples", state: "Draft", rows: [] });

// A created training Model must survive restart as Model context, while a late
// CLI receipt must not replace another Model or a newer explicit selection.
test("created Models attach durably to their originating chat without stealing newer focus", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-chat-created-model-"));
  let store = new SqliteStore(home);
  try {
    await store.insertSessionAtFront(SessionSchema.parse({id:"chat",provider:"codex",title:"Train a model",appId:null,appName:null,cwd:null,codexThreadId:null,pinned:false,archived:false,order:0,status:"idle",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
    let scopes = createChatExperimentScopes(store);
    const initial = await scopes.create("chat", "original-data");
    const source = initial.scopes[0]!;
    await scopes.select("chat", {scopeId:source.id,dataset:dataset(1)});
    const before = chatExperimentContext((await store.getSession("chat"))?.metadata);
    const startedAt = new Date().toISOString();
    await store.insertTurn(TurnSchema.parse({id:"train",sessionId:"chat",prompt:"Train a model",providerTurnId:null,startedAt,completedAt:null,status:"in_progress",error:null,
      metadata:{chatExperimentScopeId:source.id,chatExperimentSelectionVersion:before.selectionVersion}}));
    const pin = {id:"model",teamId:"team",actorId:"actor",apiOrigin:"https://api.example.test"};
    await scopes.attachModel("chat", "train", pin, "Arithmetic model");
    await store.close(); store = new SqliteStore(home); scopes = createChatExperimentScopes(store);
    const saved = (await store.getSession("chat"))!;
    const state = chatExperimentContext(saved.metadata);
    expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0]).toMatchObject({id:source.id,model:pin,dataset:dataset(1),name:"Arithmetic model"});
    expect(saved.metadata?.chatContextSelection).toEqual({kind:"model",id:pin.id,location:"cloud",teamId:pin.teamId,apiOrigin:pin.apiOrigin});
    const newer = {kind:"model",id:"different",location:"local"};
    await store.updateSession("chat", session => ({...session,metadata:{...session.metadata,chatContextSelection:newer,
      chatContextSelectedAt:new Date(Date.parse(startedAt)+1000).toISOString()}}));
    await scopes.attachModel("chat", "train", pin, "Arithmetic model");
    await scopes.attachModel("chat", "train", {...pin,actorId:"other-account"}, "Other account model");
    const late = (await store.getSession("chat"))!;
    expect(late.metadata?.chatContextSelection).toEqual(newer);
    expect(chatExperimentContext(late.metadata).scopes.map(scope=>scope.model?.actorId)).toEqual(["actor","other-account"]);
    await expect(scopes.attachModel("another-chat", "train", pin, "Wrong chat")).rejects.toThrow("originating conversation");
  } finally { await store.close(); await rm(home, {recursive:true,force:true}); }
});

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
    // Inspecting a training job without a dataset, then browsing a dataset,
    // must not present that job as a run of the newly selected dataset.
    await store.insertSessionAtFront(SessionSchema.parse({ id:"chat-c",provider:"codex",title:"Context switch",appId:null,appName:null,cwd:null,codexThreadId:null,pinned:false,archived:false,order:0,
      createdAt:"2026-10-01T00:00:00.000Z",updatedAt:"2026-10-01T00:00:00.000Z",status:"idle" }));
    await store.insertTurn(TurnSchema.parse({ id:"training-view",sessionId:"chat-c",prompt:"Status",providerTurnId:null,
      startedAt:"2026-10-13T00:00:00.000Z",completedAt:null,status:"in_progress",error:null,metadata:{} }));
    await scopes.attachTraining("chat-c","training-view",training);
    const switched = await scopes.select("chat-c",{dataset:dataset(1)});
    expect(switched.scopes[0]!.dataset).toBeNull();
    expect(switched.scopes[0]!.training).toEqual([training]);
    expect(switched.activeScopeId).toBe(switched.datasetFocus!.id);
    expect(switched.datasetFocus?.dataset?.id).toBe("examples");
    expect(switched.datasetFocus?.training ?? []).toEqual([]);

    // Browsing saved runs at different revisions must reuse their scopes,
    // including after restart, without merging explicit experiments or owners.
    await store.insertSessionAtFront(SessionSchema.parse({ id:"chat-reselect",provider:"codex",title:"Retained history",appId:null,appName:null,cwd:null,codexThreadId:null,pinned:false,archived:false,order:0,
      createdAt:"2026-10-01T00:00:00.000Z",updatedAt:"2026-10-01T00:00:00.000Z",status:"idle" }));
    const originalDataset = { ...dataset(1), owner: ownerA };
    const revisedDataset = { ...dataset(2), owner: ownerA };
    const originalRun = { ...run, owner: ownerA, state:"Completed" };
    const revisedRun = { ...originalRun, id:"revised-run", datasetRevision:2 };
    const originalScope = (await scopes.select("chat-reselect", { dataset:originalDataset, run:originalRun })).activeScopeId;
    const revisedScope = (await scopes.select("chat-reselect", { dataset:revisedDataset, run:revisedRun })).activeScopeId;
    expect(revisedScope).not.toBe(originalScope);
    for (let repeat = 0; repeat < 2; repeat++) {
      const original = await scopes.select("chat-reselect", { dataset:originalDataset, run:originalRun });
      expect(original.activeScopeId).toBe(originalScope);
      expect(original.scopes).toHaveLength(2);
      const revised = await scopes.select("chat-reselect", { dataset:revisedDataset, run:revisedRun });
      expect(revised.activeScopeId).toBe(revisedScope);
      expect(revised.scopes).toHaveLength(2);
    }
    store.close(); store = new SqliteStore(home); scopes = createChatExperimentScopes(store);
    const restored = await scopes.select("chat-reselect", { dataset:originalDataset, run:originalRun });
    expect(restored.activeScopeId).toBe(originalScope);
    expect(restored.scopes.map(scope => [scope.dataset?.revision, scope.runs[0]?.id])).toEqual([[1,originalRun.id],[2,revisedRun.id]]);
    const explicit = await scopes.create("chat-reselect", "intentional-new-experiment");
    const explicitId = explicit.activeScopeId!;
    expect(explicit.scopes).toHaveLength(3);
    const separate = await scopes.select("chat-reselect", { scopeId:explicitId, dataset:originalDataset, run:originalRun });
    expect(separate.activeScopeId).toBe(explicitId);
    expect(separate.scopes).toHaveLength(3);
    const foreign = await scopes.select("chat-reselect", { dataset:{...originalDataset,owner:ownerB}, run:{...originalRun,owner:ownerB} });
    expect(foreign.scopes).toHaveLength(4);
    expect(foreign.activeScopeId).not.toBe(originalScope);
    expect(foreign.scopes.find(scope=>scope.id===originalScope)?.dataset?.owner).toEqual(ownerA);

    // Editing attachments survive restart without replacing a newer selection
    // or aliasing the same remote ID in different accounts.
    const beforeWeight=chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    await store.insertTurn(TurnSchema.parse({id:"weight-turn",sessionId:"chat-a",prompt:"Inspect weights",providerTurnId:null,
      startedAt:new Date().toISOString(),completedAt:null,status:"in_progress",error:null,
      metadata:{chatExperimentSelectionVersion:beforeWeight.selectionVersion}}));
    const pin={id:"remote-session",teamId:"team",actorId:"actor",apiOrigin:"https://api.example.test",name:"Parameter study"};
    const attached=await scopes.attachWeightSpace("chat-a","weight-turn",pin);
    const editing=attached.scopes.find(item=>item.weightSpace?.id===pin.id)!;
    expect(attached.activeScopeId).toBe(editing.id);
    await scopes.select("chat-a",{scopeId:first.id});
    const late=await scopes.attachWeightSpace("chat-a","weight-turn",pin);
    expect(late.activeScopeId).toBe(first.id);
    expect(late.scopes.filter(item=>item.weightSpace?.id===pin.id)).toHaveLength(1);
    await scopes.attachWeightSpace("chat-a","weight-turn",{...pin,actorId:"another-actor"});
    store.close();store=new SqliteStore(home);scopes=createChatExperimentScopes(store);
    const recoveredWeights=chatExperimentContext((await store.getSession("chat-a"))?.metadata);
    expect(recoveredWeights.activeScopeId).toBe(first.id);
    expect(recoveredWeights.scopes.filter(item=>item.weightSpace?.id===pin.id).map(item=>item.weightSpace?.actorId).sort()).toEqual(["actor","another-actor"]);
  } finally { await store.close(); await rm(home, { recursive: true, force: true }); }
});
