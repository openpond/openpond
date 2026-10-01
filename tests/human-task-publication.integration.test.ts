import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {tasksetDraftFromTaskset,publishTasksetDraft,materializePortableTasksetRelease,writeTasksetDraftPackage} from "@openpond/taskset-sdk";
import {createHumanReviewService,sealHumanTaskProposal} from "@openpond/evals/human-review";
import {tasksetFixture,withTrainingStore} from "./helpers/training-fixtures.js";
import {captureAuthoredModelTasksetPackage} from "../apps/server/src/training/model-taskset-package-capture.js";
import {desktopTasksetRuntimeAdapterId} from "../apps/server/src/training/portable-evals-adapter.js";
import {resolveTasksetRewardBinding} from "../apps/server/src/training/taskset-reward-binding.js";
import {SqliteStore} from "../apps/server/src/store/store.js";
import type {TasksetPackage} from "openpond-sdk/taskset-packages";
import {resolveLocalHumanPublishedPackage} from "../apps/server/src/human-review/published-package.js";
import {publishLocalHumanTaskProposal} from "../apps/server/src/human-review/task-publication.js";
// Failure story: accepting a task edit must publish from actual retained bytes,
// preserve evaluator-only assets and recover the same revision after restart.
test("accepted author proposals publish one retained revision with private source bytes intact",async()=>withTrainingStore(async({store,directory})=>{
 const document=tasksetDraftFromTaskset(tasksetFixture(),"2026-10-01T00:00:00.000Z"),packageDirectory=path.join(directory,"actual-authoring");
 document.environment.resources=document.tasks.map(task=>({id:task.privilegedContextRef!,kind:"file",path:`assets/${task.id}.json`,mediaType:"application/json",visibility:"privileged",required:true,metadata:{}}));
 await writeTasksetDraftPackage(document,packageDirectory);await mkdir(path.join(packageDirectory,"assets"),{recursive:true});for(const task of document.tasks)await writeFile(path.join(packageDirectory,`assets/${task.id}.json`),JSON.stringify(task.expectedOutput));
 const draft=await store.importTasksetDraftPackage({packagePath:packageDirectory,profileId:document.profileId});
 const workspace=(await store.getTasksetDraftWorkspace(draft.id))!;
 const authored=publishTasksetDraft({draft,now:draft.updatedAt,sourcePackageHash:workspace.packageHash});
 const materialized=await store.materializePublishedTasksetPackage({draftId:draft.id,taskset:authored});
 const source=(await store.finalizeTasksetDraftPublication({draft,packageHash:workspace.packageHash,taskset:materialized.taskset})).taskset;
 const release=materializePortableTasksetRelease({taskset:source,rewardExecution:await resolveTasksetRewardBinding(store,source),adapterId:desktopTasksetRuntimeAdapterId(source)});
 const baseline=await captureAuthoredModelTasksetPackage({storeDir:directory,taskset:source,content:{schemaVersion:"openpond.tasksetPackage.v1",taskset:release.tasksetRelease,environment:release.environmentRelease,verifierSet:release.verifierSetRelease}});
 const pin={id:baseline.taskset.id,revision:baseline.taskset.revision,contentHash:baseline.taskset.contentHash};
 const form={schemaVersion:"openpond.humanForm.v1" as const,mode:"individual" as const,instructions:"Review the proposed task",criteria:[{id:"quality",label:"Quality",instructions:"Assess proposed wording",allowAbstain:false,kind:"score" as const,minimum:0,maximum:5,step:1,required:true}]};
 let published:TasksetPackage|undefined;
 const service=createHumanReviewService(store.humanReviewRepository(),{async member(){},async owner(){return true;},async evidence(){},async assignee(){},async publication(_context,_review,value){if(!published||contentHash(value)!==contentHash({id:published.taskset.id,revision:published.taskset.revision,contentHash:published.taskset.contentHash}))throw new Error("Publication differs");}}),context={scope:"team",actorId:"owner"};
 const review=await service.command(context,{action:"create",id:"author-package",operationId:"create",expectedRevision:0,projectId:"project",kind:"author",title:"Edit task",assigneeId:null,evidence:{dataset:pin,grader:pin,graderBinding:{id:"human",version:"1",contentHash:contentHash("human")},rubric:pin,attempts:[],taskIds:["task_train"]},form,policy:{approval:"none",minimumRaters:1,managerIds:[],reviewerIds:[],queueClaim:false,teamVisible:false}});
 const proposal=sealHumanTaskProposal([{taskId:"task_train",input:{prompt:"Say hello clearly"},policyVisibleContext:{context:"Approved visible context"},tags:["authored"]}]);
 const accepted=await service.command(context,{action:"submit",id:review.id,operationId:"submit",expectedRevision:review.revision,generation:review.generation,evidenceHash:contentHash(review.evidence),formHash:contentHash(form),answers:[{criterionId:"quality",value:4,abstain:false,note:""}],note:"",taskProposal:proposal});
 const input={store,storeDir:directory,actorId:"owner",review:accepted,proposalHash:proposal.contentHash,baseline};
 const first=await publishLocalHumanTaskProposal(input);
 published=first;expect(first.taskset.metadata.sourceTasksetId).toBe(baseline.taskset.metadata.sourceTasksetId);expect(first.taskset.revision).toBe(baseline.taskset.revision+1);
 expect(first.taskset.tasks.find(t=>t.id==="task_train")?.input.prompt).toBe("Say hello clearly");
 expect(baseline.taskset.tasks.find(t=>t.id==="task_train")?.input.prompt).toBe("Say hello");
 const protectedFiles=baseline.files.filter(file=>baseline.taskset.tasks.some(task=>task.privilegedContextRef===file.asset.id));expect(protectedFiles).toHaveLength(2);for(const original of protectedFiles)expect(first.files.find(file=>file.asset.id===original.asset.id)?.base64).toBe(original.base64);
 expect(first.taskset.graders).toEqual(baseline.taskset.graders);expect(first.taskset.policy).toEqual(baseline.taskset.policy);
 const publishedReview=await service.command(context,{action:"bind_author_publication",id:accepted.id,expectedRevision:accepted.revision,operationId:"publish",proposalHash:proposal.contentHash,dataset:{id:first.taskset.id,revision:first.taskset.revision,contentHash:first.taskset.contentHash}});
 const fresh=new SqliteStore(directory);try{const retry=await publishLocalHumanTaskProposal({...input,store:fresh});expect(retry.contentHash).toBe(first.contentHash);expect(retry.taskset).toEqual(first.taskset);const resolved=await resolveLocalHumanPublishedPackage({store:fresh,storeDir:directory,scope:context.scope,actorId:context.actorId,projectId:accepted.projectId,release:publishedReview.authorPublication!.dataset,loadBaseline:async reference=>{expect(reference).toEqual(pin);return baseline;}});expect(resolved?.contentHash).toBe(first.contentHash);await expect(resolveLocalHumanPublishedPackage({store:fresh,storeDir:directory,scope:context.scope,actorId:"different-owner",projectId:accepted.projectId,release:publishedReview.authorPublication!.dataset,loadBaseline:async()=>baseline})).rejects.toThrow("human_task_publication_source_denied");}finally{await fresh.close();}
}));
