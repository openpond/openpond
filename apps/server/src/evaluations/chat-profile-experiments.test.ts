import { expect, test, vi } from "vitest";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import type { SqliteStore } from "../store/store.js";
import type { LocalProfileEvaluationRun } from "../store/profile-evaluation-record.js";
import { createChatProfileExperiments } from "./chat-profile-experiments.js";

vi.mock("../harness/profile-evaluation-run-inspection.js",()=>({inspectProfileEvaluationRun:async()=>({cases:[
  {receiptId:"good",taskId:"one",seed:"1",gradingStatus:"scored",score:1,passed:true,failureClass:null,costUsd:0},
  {receiptId:"bad",taskId:"two",seed:"1",gradingStatus:"scored",score:0,passed:false,failureClass:"wrong_quote",costUsd:0},
]})}));

// A completed workflow must preserve its real metric and source authority;
// successful execution alone cannot attach it after the selected Profile changes.
test("Profile association preserves saved evidence and denies changed source authority", async()=>{
  const ref={source:"local" as const,repositoryId:"/profiles/rfq",profileId:"rfq"};
  const run={profileRef:ref,contentHash:"b".repeat(64),manifest:{id:"profile-run",packageHash:"c".repeat(64),contentHash:"d".repeat(64),
    profileEvaluation:{definitionId:"quote",sourceRevision:"source-1",profileId:"rfq"},population:[{},{}],policy:{kind:"model",model:{provider:"codex"}}},
    metric:{policy:{aggregation:"pass_rate"},value:0.5}} as unknown as LocalProfileEvaluationRun;
  const store={getProfileEvaluationRun:async()=>run} as unknown as SqliteStore;
  let selected={ref,sourceRevision:"source-1"},admitted=true;
  const execute=vi.fn(async()=>run),attach=vi.fn(async(_context:unknown,_resources:unknown[])=>{});
  const owner=createChatProfileExperiments({store,loadPackage:async()=>({taskset:{id:"rfq",revision:2,contentHash:"a".repeat(64),metadata:{},graders:[]}} as unknown as TasksetPackage),execute,attach,discover:async()=>({cases:[]}),prepare:async()=>({manifest:run.manifest}),selectedProfile:async()=>selected,selectedProfileRef:async()=>selected.ref,
    resolveInvocation:async()=>{if(!admitted)throw new Error("invalid context");return {sessionId:"chat",turnId:"turn"};}});
  await owner.prepare({id:"prepare",invocationToken:"signed"});
  expect(attach.mock.calls[0]![1].some(resource=>(resource as {kind:string}).kind==="experiment")).toBe(false);
  attach.mockClear();
  expect(await owner.request({id:"request",invocationToken:"signed"})).toBe(run);
  expect(execute).toHaveBeenCalledWith({id:"request"});
  const inspected=await owner.inspect("profile-run",ref);
  expect(inspected.summary).toMatchObject({profileRef:ref,datasetId:"rfq",datasetRevision:2,score:0.5,scoreLabel:"Pass rate",evaluatedCount:2,failedCount:1,costUsd:null});
  expect(inspected.view.cases.map(row=>row.output)).toEqual([null,null]);
  attach.mockClear();
  await owner.discover({view:"history",invocationToken:"signed"});expect(attach).not.toHaveBeenCalled();
  await owner.discover({runId:"profile-run",invocationToken:"signed"});expect(attach).toHaveBeenCalledOnce();
  attach.mockClear();execute.mockClear();admitted=false;
  await expect(owner.request({invocationToken:"bad"})).rejects.toThrow("invalid context");expect(execute).not.toHaveBeenCalled();
  admitted=true;selected={ref,sourceRevision:"source-2"};
  await expect(owner.request({invocationToken:"signed"})).rejects.toThrow("source changed");expect(attach).not.toHaveBeenCalled();
  selected={ref:{...ref,profileId:"another"},sourceRevision:"source-1"};
  await expect(owner.inspect("profile-run",ref)).rejects.toThrow("owns this saved experiment");
});
