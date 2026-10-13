import {expect,test} from "vitest";
import type {ChatResourceSummary} from "@openpond/contracts";
import {experimentAction} from "../apps/web/src/components/chat/composer-experiment-action";
import {captureComposerResourceContext,mergeComposerResourceContexts} from "../apps/web/src/components/chat/composer-resource-context";

// Failure story: a revised dataset or different provider/model must not inherit
// an old result's Improve action; preparing two requests must retain both pins.
test("resource actions distinguish changed evidence and preserve draft model targets",()=>{
  const dataset:ChatResourceSummary={kind:"dataset",id:"data",revision:1,name:"Examples",state:"Runnable",taskCount:3,rows:[],evaluationHash:"a".repeat(64)};
  const run:ChatResourceSummary={kind:"experiment",id:"run",revision:1,name:"Run",state:"completed",datasetId:"data",datasetRevision:1,model:"codex/model-a",rows:[],evaluationHash:dataset.evaluationHash};
  const ready={isExperiment:true,dataset,graders:1,model:run.model,modelAvailable:true,run};
  expect(experimentAction(ready)).toBe("Improve");
  expect(experimentAction({...ready,executionLocation:"cloud"})).toBe("Run updated");
  expect(experimentAction({...ready,isExperiment:false})).toBe("New experiment");
  expect(experimentAction({...ready,run:null})).toBe("Run");
  expect(experimentAction({...ready,dataset:{...dataset,revision:2,evaluationHash:"b".repeat(64)}})).toBe("Run updated");
  expect(experimentAction({...ready,model:"openpond/model-a"})).toBe("Run updated");
  expect(experimentAction({...ready,dataset:{...dataset,owner:{teamId:"other",actorId:"other"}}})).toBe("Run updated");
  expect(experimentAction({...ready,modelAvailable:false})).toBe("Set up");
  expect(experimentAction({...ready,dataset:{...dataset,taskCount:0}})).toBe("Set up");
  expect(experimentAction({...ready,modelAvailable:false,run:{...run,state:"running"}})).toBe("View progress");
  expect(experimentAction({...ready,run:{...run,state:"failed"}})).toBe("Retry");
  const resources={scope:{id:"scope",runs:[run],evaluationModel:run.model,selectedGraderId:null},focus:{dataset,experiment:null,scopeContext:{selectionVersion:1}},graders:[],experiments:[run]} as unknown as Parameters<typeof captureComposerResourceContext>[0];
  const drafted=captureComposerResourceContext(resources);
  resources.scope!.evaluationModel="openpond/model-b";
  resources.scope!.executionLocation="cloud";
  const combined=mergeComposerResourceContexts(drafted,captureComposerResourceContext(resources));
  expect(combined.map(context=>context.executionLocation)).toEqual(["local","cloud"]);
  expect(combined.map(context=>context.evaluationModel)).toEqual(["codex/model-a","openpond/model-b"]);
  expect(combined[0]!.resources).toContainEqual(expect.objectContaining({kind:"experiment",id:"run"}));
});
