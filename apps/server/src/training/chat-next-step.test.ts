import { expect, test } from "vitest";
import { SessionSchema, TurnSchema, type ChatContextSelection } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { createChatNextStepService } from "./chat-next-step.js";

function fixture() {
  let session=SessionSchema.parse({id:"chat",provider:"codex",title:"Chat",appId:null,appName:null,cwd:null,codexThreadId:null,pinned:false,archived:false,order:0,createdAt:"2026-10-15T00:00:00Z",updatedAt:"2026-10-15T00:00:00Z",status:"idle"});
  let turn=TurnSchema.parse({id:"turn",sessionId:"chat",prompt:"Inspect",providerTurnId:null,startedAt:"2026-10-15T00:00:00Z",completedAt:"2026-10-15T00:01:00Z",status:"completed",error:null,metadata:{}});
  const dataset={kind:"dataset" as const,id:"data",name:"Dataset",revision:1,state:"Ready",rows:[],taskCount:2};
  const run={kind:"experiment" as const,id:"run",name:"Result",revision:1,state:"failed",rows:[],datasetId:"data",datasetRevision:1};
  let focus:ChatContextSelection|null={target:{kind:"experiment",id:"run",location:"local"},label:"Result",detail:"",resource:run,dataset,graders:[]};
  session.metadata={chatExperimentContext:{scopes:[{id:"scope",operationId:"created",ordinal:1,name:"Experiment",dataset,graders:[],selectedGraderId:null,runs:[run],selectedRunId:"run",turnIds:[turn.id],createdAt:session.createdAt,updatedAt:session.updatedAt}],activeScopeId:"scope",selectionVersion:0,selectedAt:null,selectionOperations:{}}};
  let pending=false;
  let beforeUpdate: (()=>void) | null = null;
  const store={getSession:async(id:string)=>id===session.id?session:null,latestTurnForSession:async()=>turn,
    taskInboxSnapshot:async()=>({inputs:pending?[{state:"pending"}]:[]}),
    updateSession:async(_id:string,update:(s:typeof session)=>typeof session)=>{beforeUpdate?.(); beforeUpdate=null; session=update(session);return session;},
  } as unknown as SqliteStore;
  const create=()=>createChatNextStepService({store,current:async()=>focus});
  return {create,set beforeUpdate(value:(()=>void)|null){beforeUpdate=value;},get session(){return session;},set session(value){session=value;},get turn(){return turn;},set turn(value){turn=value;},get focus(){return focus;},set focus(value){focus=value;},set pending(value:boolean){pending=value;}};
}

// A double key/click must consume one recommendation once; reload cannot offer it again.
test("next steps consume once, persist dismissal, and reject stale or cross-chat acceptance",async()=>{
  const f=fixture(),service=f.create();
  const first=await service.request({sessionId:"chat"}) as {suggestion:{id:string;contexts:unknown[]}};
  expect(first.suggestion.contexts).toHaveLength(1);
  const accepted=await Promise.all([service.request({sessionId:"chat",operation:"accept",id:first.suggestion.id}),service.request({sessionId:"chat",operation:"accept",id:first.suggestion.id})]);
  expect(accepted.filter(item=>"suggestion" in item && item.suggestion)).toHaveLength(1);
  expect(await f.create().request({sessionId:"chat"})).toMatchObject({suggestion:null});
  f.turn={...f.turn,id:"turn2"};
  const next=await service.request({sessionId:"chat"}) as {suggestion:{id:string}};
  f.focus={...f.focus!,dataset:{...f.focus!.dataset!,revision:2}};
  expect(await service.request({sessionId:"chat",operation:"accept",id:next.suggestion.id})).toMatchObject({suggestion:null,stale:true});
  expect(await service.request({sessionId:"other",operation:"accept",id:next.suggestion.id})).toMatchObject({suggestion:null});
  const current=await service.request({sessionId:"chat"}) as {suggestion:{id:string}};
  await service.request({sessionId:"chat",operation:"dismiss",id:current.suggestion.id});
  expect(await f.create().request({sessionId:"chat"})).toMatchObject({suggestion:null});
});

// Recommendations never bypass current-turn provenance, readiness, queued work, or evaluation isolation.
test("next steps validate recommendation provenance and suppress ineligible runtime states",async()=>{
  const f=fixture(),service=f.create();
  f.pending=true;expect(await service.request({sessionId:"chat"})).toMatchObject({suggestion:null});f.pending=false;
  f.turn={...f.turn,status:"in_progress"};
  expect(await service.request({sessionId:"chat"})).toMatchObject({suggestion:null});
  await expect(service.request({sessionId:"chat",operation:"recommend",action:"prepare_evaluation"},{sessionId:"chat",turnId:f.turn.id})).rejects.toThrow("not eligible");
  await expect(service.request({sessionId:"other",operation:"recommend",action:"diagnose"},{sessionId:"chat",turnId:f.turn.id})).rejects.toThrow("another chat");
  expect(await service.request({sessionId:"chat",operation:"recommend",action:"diagnose"},{sessionId:"chat",turnId:f.turn.id})).toMatchObject({recommended:"diagnose"});
  f.turn={...f.turn,status:"completed"};
  expect(await service.request({sessionId:"chat"})).toMatchObject({suggestion:{action:"diagnose",sourceTurnId:f.turn.id}});
  for(const metadata of [{profileEvaluationRun:{}},{standaloneExperiment:{}},{localProfileExperiment:{}},{refinementCandidate:{}},{source:"experiment-improvement"}]) {
    f.session={...f.session,metadata:{...f.session.metadata,...metadata}};
    expect(await service.request({sessionId:"chat"})).toMatchObject({suggestion:null});
  }
});

// A newer completed turn can race acceptance while the session remains idle.
test("acceptance never returns an old draft when a terminal turn changes during persistence",async()=>{
  const f=fixture(), service=f.create();
  const first=await service.request({sessionId:"chat"}) as {suggestion:{id:string}};
  f.beforeUpdate=()=>{f.turn={...f.turn,id:"new-terminal-turn"};};
  expect(await service.request({sessionId:"chat",operation:"accept",id:first.suggestion.id})).toMatchObject({suggestion:null,stale:true});
  expect(await service.request({sessionId:"chat"})).toMatchObject({suggestion:{sourceTurnId:"new-terminal-turn"}});
});
