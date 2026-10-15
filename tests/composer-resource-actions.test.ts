import {expect,test} from "vitest";
import type {ChatResourceSummary} from "@openpond/contracts";
import {captureComposerResourceContext,mergeComposerResourceContexts} from "../apps/web/src/components/chat/composer-resource-context";
import { datasetWorkspaceContext } from "../apps/web/src/components/chat/dataset-workspace-data";

// Failure story: preparing two requests must retain each model and execution pin.
test("resource requests preserve draft model targets",()=>{
  const dataset:ChatResourceSummary={kind:"dataset",id:"data",revision:1,name:"Examples",state:"Runnable",taskCount:3,rows:[],evaluationHash:"a".repeat(64)};
  const run:ChatResourceSummary={kind:"experiment",id:"run",revision:1,name:"Run",state:"completed",datasetId:"data",datasetRevision:1,model:"codex/model-a",rows:[],evaluationHash:dataset.evaluationHash};
  const resources={scope:{id:"scope",runs:[run],evaluationModel:run.model,selectedGraderId:null},focus:{dataset,experiment:null,scopeContext:{selectionVersion:1}},graders:[],experiments:[run]} as unknown as Parameters<typeof captureComposerResourceContext>[0];
  const drafted=captureComposerResourceContext(resources);
  resources.scope!.evaluationModel="openpond/model-b";
  resources.scope!.executionLocation="cloud";
  const combined=mergeComposerResourceContexts(drafted,captureComposerResourceContext(resources));
  expect(combined.map(context=>context.executionLocation)).toEqual(["local","cloud"]);
  expect(combined.map(context=>context.evaluationModel)).toEqual(["codex/model-a","openpond/model-b"]);
  expect(combined[0]!.resources).toContainEqual(expect.objectContaining({kind:"experiment",id:"run"}));
});

// Failure story: diagnosing a historical row must not attach today's grader
// revision or a same-named Dataset owned by another account.
test("dataset sidebar actions retain historical run pins and reject foreign owners",()=>{
  const dataset:ChatResourceSummary={kind:"dataset",id:"data",revision:4,name:"Examples",state:"Runnable",rows:[]};
  const run:ChatResourceSummary={kind:"experiment",id:"old-run",revision:1,name:"Old run",state:"completed",datasetId:"data",datasetRevision:2,model:"codex/model-a",location:"local",rows:[]};
  const resources={scope:{id:"scope",evaluationModel:"openpond/new-model",executionLocation:"cloud"},focus:{dataset,scopeContext:{selectionVersion:7}},graders:[{kind:"grader",id:"current-grader",revision:4,datasetId:"data",datasetRevision:4}]} as unknown as Parameters<typeof datasetWorkspaceContext>[0];
  const context=datasetWorkspaceContext(resources,run)[0]!;
  expect(context).toMatchObject({scopeId:"scope",selectionVersion:7,evaluationModel:"codex/model-a",executionLocation:"local"});
  expect(context.resources).toEqual([{kind:"dataset",id:"data",revision:2},{kind:"experiment",id:"old-run",revision:1,datasetId:"data",datasetRevision:2}]);
  expect(resources.focus.dataset?.revision).toBe(4);
  expect(()=>datasetWorkspaceContext(resources,{...run,owner:{teamId:"foreign",actorId:"foreign"}})).toThrow("different Dataset");
});
