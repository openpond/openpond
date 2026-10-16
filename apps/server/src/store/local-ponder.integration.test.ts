import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SqliteStore } from "./store.js";
import { createSessionStore } from "./session-store.js";
import type { TaskInputAdmission } from "@openpond/contracts";

// Taking control must fence queued orchestration across restart while preserving
// the actual worker identity, accepted input history and explicit return revision.
it("atomically transfers worker control and fences stale coordinator inputs across restart", async()=>{
  const home=await mkdtemp(path.join(tmpdir(),"local-ponder-control-"));
  let store=new SqliteStore(home);
  const service=()=>createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}});
  try {
    const coordinator=await service().createSession({provider:"openai",systemKind:"openpond.ponder",hiddenFromDefaultSidebar:true});
    const worker=await service().createSession({provider:"codex",parentSessionId:coordinator.id,hiddenFromDefaultSidebar:true});
    const timestamp=new Date().toISOString();
    await store.registerLocalPonderAgent({sessionId:worker.id,coordinatorId:"coordinator",coordinatorSessionId:coordinator.id,
      owner:"ponder",revision:1,assignment:"Bounded work",creationKey:"assignment-1",createdAt:timestamp,updatedAt:timestamp});
    const admission:TaskInputAdmission={id:"input-1",sessionId:worker.id,senderSessionId:coordinator.id,senderKind:"task",kind:"followup",
      body:"Original assignment",payload:{localPonderControlRevision:1},idempotencyKey:"original",replyTo:null,expectedTurnId:null};
    await store.admitTaskInput(admission);
    const takeover=await store.controlLocalPonderAgent(worker.id,"user",1);
    expect(takeover.relationship.revision).toBe(2);
    expect((await store.getSession(worker.id))?.hiddenFromDefaultSidebar).toBe(false);
    expect((await store.getTaskInput("input-1"))?.state).toBe("rejected");
    await expect(store.admitTaskInput({...admission,id:"stale",idempotencyKey:"stale"})).rejects.toThrow("local_ponder_control_changed");
    await expect(store.controlLocalPonderAgent(worker.id,"ponder",1)).rejects.toThrow("local_ponder_control_changed");
    await store.close();store=new SqliteStore(home);
    expect((await store.localPonderAgents())[0]?.owner).toBe("user");
    expect((await store.getSession(worker.id))?.hiddenFromDefaultSidebar).toBe(false);
    const returned=await store.controlLocalPonderAgent(worker.id,"ponder",2);
    expect(returned.session.id).toBe(worker.id);
    expect(returned.relationship.revision).toBe(3);
    await expect(store.admitTaskInput({...admission,id:"stale-return",idempotencyKey:"stale-return"})).rejects.toThrow("local_ponder_control_changed");
    const fresh=await store.admitTaskInput({...admission,id:"fresh",idempotencyKey:"fresh",payload:{localPonderControlRevision:3}});
    expect(fresh.state).toBe("pending");
    expect((await store.getTaskInput("input-1"))?.state).toBe("rejected");
    const races=await Promise.allSettled([store.controlLocalPonderAgent(worker.id,"user",3),store.controlLocalPonderAgent(worker.id,"user",3)]);
    expect(races.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect((await store.getTaskInput("fresh"))?.state).toBe("rejected");
  } finally {await store.close();await rm(home,{recursive:true,force:true});}
});

// Losing the setup response must recover the reserved coordinator without a
// hosted account, a second conversation, or changing the selected provider.
it("recovers account-free local setup and changes its model only at an idle boundary",async()=>{
  const {createLocalPonderService}=await import("../openpond/local-ponder-service.js");
  const {ProviderSettingsSchema}=await import("@openpond/contracts");
  const home=await mkdtemp(path.join(tmpdir(),"local-ponder-setup-"));
  const store=new SqliteStore(home);
  const sessions=createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}});
  const settings=ProviderSettingsSchema.parse({statuses:{openai:{id:"openai",displayName:"OpenAI",enabled:true,available:true,
    routing:{localRuntime:true,localByok:true},capabilities:{toolCalling:true}}},
    modelCaches:{openai:{providerId:"openai",models:["configured-a","configured-b"].map(id=>({id,displayName:id,providerId:"openai",source:"manual",capabilities:{toolCalling:true}}))}}});
  let interruptSetup=true;
  const makeService=()=>createLocalPonderService({store,createSession:sessions.createSession,
    createReservedSession:async(payload,reservation)=>{
      const result=await sessions.createReservedSession(payload,reservation);
      if(interruptSetup) {interruptSetup=false;throw new Error("simulated lost setup response");}
      return result;
    },providerSettings:async()=>settings,appendRuntimeEvent:async()=>{}});
  try {
    const initial=await makeService().read();
    expect(initial.session).toBeNull();
    await expect(makeService().configure({modelRef:{providerId:"openai",modelId:"not-configured"}})).rejects.toThrow("local_ponder_model_unavailable");
    await expect(makeService().configure({modelRef:{providerId:"openai",modelId:"configured-a"}})).rejects.toThrow("simulated lost setup response");
    const recovered=await makeService().configure({modelRef:{providerId:"openai",modelId:"configured-a"}});
    expect(recovered.session?.systemKind).toBe("openpond.ponder");
    expect(await store.sessionCount()).toBe(1);
    const changed=await makeService().configure({modelRef:{providerId:"openai",modelId:"configured-b"}});
    expect(changed.session?.id).toBe(recovered.session?.id);
    expect(changed.session?.modelRef).toEqual(changed.coordinator.modelRef);
    await store.updateSession(changed.session!.id,session=>({...session,status:"active"}));
    await expect(makeService().configure({modelRef:{providerId:"openai",modelId:"configured-a"}})).rejects.toThrow("local_ponder_model_change_requires_idle");
    expect((await makeService().read()).coordinator.modelRef?.modelId).toBe("configured-b");
  } finally {await store.close();await rm(home,{recursive:true,force:true});}
});

// Exercise the actual tool-to-inbox boundary: configured discovery must launch
// one persistent worker, return its exact new input and respect user takeover.
it("delegates through the local tool boundary without duplicating or stealing a worker",async()=>{
  const {localPonderTools}=await import("../openpond/local-ponder-tools.js");
  const {taskCoordinationTools}=await import("../openpond/task-coordination-tools.js");
  const {filterModelToolsForExperience}=await import("../runtime/experience-policy.js");
  const {createTaskInboxRuntime}=await import("../runtime/task-inbox/runtime.js");
  const {ProviderSettingsSchema,TurnSchema}=await import("@openpond/contracts");
  const home=await mkdtemp(path.join(tmpdir(),"local-ponder-tools-"));
  const store=new SqliteStore(home);
  const sessions=createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}});
  const inbox=createTaskInboxRuntime({store,getSession:sessions.getSession,listSessions:()=>store.sessionShells(),
    getTurn:id=>store.getTurn(id),latestTurn:id=>store.latestTurnForSession(id),recoverInterruptedTurn:async()=>{},
    getSubagentRun:async()=>null,getActiveTurn:()=>undefined,
    startFollowup:async()=>{throw new Error("This boundary fixture must not run inference");},
    appendRuntimeEvent:async event=>{await store.appendRuntimeEvent(event);},yieldWhileWaiting:work=>work(),
    // Keep admission durable and queued; execution is a separate qualified boundary.
    dispatchFollowup:async()=>{}});
  try {
    const coordinator=await sessions.createSession({provider:"openai",systemKind:"openpond.ponder",experience:"work",hiddenFromDefaultSidebar:true});
    await store.saveLocalPonderState({id:"coordinator",location:"local",sessionId:coordinator.id,modelRef:{providerId:"openai",modelId:"configured-api"},
      revision:1,remoteAccessEnabled:false,hostedSandboxesEnabled:false,hostedActivation:"inactive"});
    const settings=ProviderSettingsSchema.parse({statuses:{codex:{id:"codex",displayName:"Codex",enabled:true,available:true,
      routing:{localRuntime:true},modelIds:["configured-native"]}},modelCaches:{codex:{providerId:"codex",models:[{id:"configured-native",providerId:"codex",displayName:"Configured native",source:"manual"}]}}});
    let stops=0;
    const definitions=localPonderTools({store,inbox,createReservedSession:sessions.createReservedSession,
      settings:async()=>settings,getSession:sessions.getSession,sessions:()=>store.sessionShells(),
      projects:async()=>[{id:"registered",name:"Registered project",workspacePath:home}],
      transcript:async(sessionId,beforeSequence)=>({sessionId,beforeSequence}),stop:async()=>{stops++;return {};}});
    const context:import("../openpond/model-tool-registry.js").ModelToolExecutionContext={session:coordinator,turnId:"coordinator-turn",callId:"launch-call",
      turnPermissions:{approvalPolicy:"on-request",sandbox:"read-only",codexPermissionMode:"default"},provider:"openai",model:"configured-api",
      args:{},signal:new AbortController().signal,workspaceDiffBaseline:null,mentionedApps:[],userPrompt:"Delegate a bounded review",turnMetadata:{}};
    const visible=filterModelToolsForExperience(coordinator,definitions.filter(tool=>tool.enabled?.({...context}) ?? true));
    const execute=async(name:string,args:Record<string,unknown>,callId=context.callId)=>{
      const tool=visible.find(tool=>tool.name===name);expect(tool).toBeDefined();
      return tool!.execute({...context,args,callId});
    };
    const discovered=await execute("openpond_discover_agents",{});
    expect(discovered.data).toMatchObject({providers:[{id:"codex",models:[{id:"configured-native"}]}],projects:[{cwd:home,localProjectId:"registered"}]});
    const assignment={title:"Review",assignment:"Review the selected change without editing",modelRef:{providerId:"codex",modelId:"configured-native"},cwd:home,localProjectId:"registered"};
    await expect(execute("openpond_start_agent",{...assignment,cwd:path.join(home,"unregistered")},"invalid-project")).rejects.toThrow("local_ponder_project_not_authorized");
    await expect(execute("openpond_start_agent",{...assignment,modelRef:{providerId:"codex",modelId:"invented"}},"invalid-model")).rejects.toThrow("local_ponder_worker_model_unavailable");
    const launched=(await execute("openpond_start_agent",assignment)).data as {sessionId:string;inputId:string};
    const retried=(await execute("openpond_start_agent",assignment)).data as {sessionId:string;inputId:string};
    expect(retried).toEqual(expect.objectContaining(launched));
    expect(await store.sessionCount()).toBe(2);
    expect((await store.getTaskInput(launched.inputId))?.sessionId).toBe(launched.sessionId);
    expect((await store.getTaskInput(launched.inputId))?.state).toBe("pending");
    const worker=await sessions.getSession(launched.sessionId);
    expect(worker.parentSessionId).toBe(coordinator.id);
    expect(worker.hiddenFromDefaultSidebar).toBe(true);
    // An older completion must not satisfy the new assignment's receipt wait.
    const timestamp=new Date().toISOString();
    await store.insertTurn(TurnSchema.parse({id:"older-completion",sessionId:worker.id,providerTurnId:null,prompt:"Earlier work",startedAt:timestamp,completedAt:timestamp,status:"completed",error:null}));
    const waitTool=taskCoordinationTools(inbox).find(tool=>tool.name==="openpond_wait_for_task")!;
    const wait=await waitTool.execute({...context,callId:"exact-wait",args:{taskId:worker.id,inputId:launched.inputId,timeoutMs:1000}});
    expect(wait.data).toMatchObject({state:"timeout",targetInputId:launched.inputId});
    await store.controlLocalPonderAgent(worker.id,"user",1);
    await expect(inbox.send({senderSessionId:coordinator.id,sessionId:worker.id,kind:"followup",body:"More work",idempotencyKey:"new-instruction"})).rejects.toThrow("local_ponder_control_changed");
    await expect(execute("openpond_stop_agent",{taskId:worker.id},"stop-after-takeover")).rejects.toThrow("local_ponder_control_changed");
    expect(stops).toBe(0);
    const inspected=await execute("openpond_inspect_agent",{taskId:worker.id,beforeSequence:30},"inspect-after-takeover");
    expect(inspected.data).toMatchObject({relationship:{owner:"user"},transcript:{sessionId:worker.id,beforeSequence:30}});
    expect((await store.getTaskInput(launched.inputId))?.state).toBe("rejected");
  } finally {await inbox.close();await store.close();await rm(home,{recursive:true,force:true});}
});

// Catalog eligibility must admit hosted-account OpenPond Chat and qualified
// managed providers, while refusing native harnesses even with rollout overrides.
it("admits managed coordinator providers without borrowing native worker eligibility",async()=>{
  const {createLocalPonderService}=await import("../openpond/local-ponder-service.js");
  const {ProviderSettingsSchema}=await import("@openpond/contracts");
  const home=await mkdtemp(path.join(tmpdir(),"local-ponder-providers-"));
  const store=new SqliteStore(home);
  const sessions=createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}});
  const providers=["openpond","openai","anthropic","codex","claude-code","grok-build","opencode","custom-openai-compatible"];
  const settings=ProviderSettingsSchema.parse({statuses:Object.fromEntries(providers.map(id=>[id,{id,displayName:id,enabled:true,available:true,routing:{localRuntime:true,localByok:id!=="openpond"},capabilities:{toolCalling:true}}])),
    modelCaches:Object.fromEntries(providers.map(id=>[id,{providerId:id,models:[{id:`${id}-configured`,displayName:id,providerId:id,source:"manual",capabilities:{toolCalling:true}}]}]))});
  const service=createLocalPonderService({store,createSession:sessions.createSession,createReservedSession:sessions.createReservedSession,providerSettings:async()=>settings,appendRuntimeEvent:async()=>{}});
  const original=process.env.OPENPOND_NATIVE_TOOL_PROVIDERS;
  process.env.OPENPOND_NATIVE_TOOL_PROVIDERS="*";
  try {
    expect((await service.read()).supportedModelRefs.map(ref=>ref.providerId)).toEqual(["openpond","openai","anthropic","custom-openai-compatible"]);
    await expect(service.configure({modelRef:{providerId:"codex",modelId:"codex-configured"}})).rejects.toThrow("local_ponder_model_unavailable");
    const configured=await service.configure({modelRef:{providerId:"openpond",modelId:"openpond-configured"}});
    expect(configured.session?.provider).toBe("openpond");
    expect((await service.read()).coordinator.modelRef).toEqual({providerId:"openpond",modelId:"openpond-configured"});
  } finally {
    if(original===undefined) delete process.env.OPENPOND_NATIVE_TOOL_PROVIDERS;else process.env.OPENPOND_NATIVE_TOOL_PROVIDERS=original;
    await store.close();await rm(home,{recursive:true,force:true});
  }
});

// A provider outage must not block reading the desktop's own stored chat.
it("reads the local coordinator while provider model discovery is pending",async()=>{
  const {createLocalPonderService}=await import("../openpond/local-ponder-service.js");
  const {ProviderSettingsSchema}=await import("@openpond/contracts");
  const home=await mkdtemp(path.join(tmpdir(),"local-ponder-snapshot-"));
  const store=new SqliteStore(home);
  const sessions=createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}});
  let resolveProvider!:(value:ReturnType<typeof ProviderSettingsSchema.parse>)=>void;
  const provider={promise:new Promise<ReturnType<typeof ProviderSettingsSchema.parse>>(resolve=>{resolveProvider=resolve;}),resolve:(value:ReturnType<typeof ProviderSettingsSchema.parse>)=>resolveProvider(value)};
  const service=createLocalPonderService({store,createSession:sessions.createSession,createReservedSession:sessions.createReservedSession,
    providerSettings:()=>provider.promise,appendRuntimeEvent:async()=>{}});
  try{
    const initial=await service.readSnapshot();
    const pending=service.read();
    const snapshot=await service.readSnapshot();
    expect(snapshot.coordinator.id).toBe(initial.coordinator.id);
    expect(snapshot.supportedModelRefs).toEqual([]);
    provider.resolve(ProviderSettingsSchema.parse({}));
    expect((await pending).coordinator.id).toBe(initial.coordinator.id);
  }finally{provider.resolve(ProviderSettingsSchema.parse({}));await store.close();await rm(home,{recursive:true,force:true});}
});
