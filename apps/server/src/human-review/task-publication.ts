import {cp,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {contentHash} from "@openpond/harness";
import {applyHumanTaskProposal,type HumanReview} from "@openpond/evals/human-review";
import {LearningDomainError} from "@openpond/evals/learning";
import {writeTasksetDraftPackage,materializePortableTasksetRelease} from "@openpond/taskset-sdk";
import {publishTasksetDraft} from "openpond-sdk/taskset-drafts";
import type {TasksetPackage} from "openpond-sdk/taskset-packages";
import type {SqliteStore} from "../store/store.js";
import {resolveTasksetRewardBinding} from "../training/taskset-reward-binding.js";
import {desktopTasksetRuntimeAdapterId} from "../training/portable-evals-adapter.js";
import {captureAuthoredModelTasksetPackage} from "../training/model-taskset-package-capture.js";
import {cacheTasksetPackage} from "../training/taskset-package-files.js";
function fail(code:string):never{throw new LearningDomainError(code,409);}
function selected(review:HumanReview,hash:string){const decision=review.decisions.at(-1);if(review.kind!=="author"||review.status!=="accepted"||decision?.taskProposalHash!==hash)fail("human_task_proposal_not_accepted");return review.submissions.find(s=>decision!.submissions.some(ref=>ref.id===s.id&&ref.contentHash===s.contentHash)&&s.taskProposal?.contentHash===hash)?.taskProposal??fail("human_task_proposal_unavailable");}
/** Clone actual retained authoring bytes and reuse ordinary validation and
 * publication. Imported/Profile datasets with no authored source are denied. */
export async function publishLocalHumanTaskProposal(input:{store:SqliteStore;storeDir:string;actorId:string;review:HumanReview;proposalHash:string;baseline:TasksetPackage}){
  const proposal=selected(input.review,input.proposalHash),metadata=input.baseline.taskset.metadata,id=metadata.sourceTasksetId,hash=metadata.sourceTasksetHash;
  if(typeof id!=="string"||typeof hash!=="string")fail("human_local_authored_source_unavailable");
  const original=await input.store.getTasksetRevision(id,input.baseline.taskset.revision,hash);if(!original)fail("human_local_authored_source_unavailable");
  const source=await input.store.readHumanPublishedTasksetDraft(original.profileId,{id:original.id,revision:original.revision,contentHash:original.contentHash});if(!source)fail("human_local_authored_source_unavailable");
  const draftId=`human-author-${contentHash([input.actorId,input.review.scope,input.review.id,input.proposalHash])}`,lineage={reviewId:input.review.id,proposalHash:input.proposalHash,actorId:input.actorId,scope:input.review.scope,projectId:input.review.projectId,baseline:input.review.evidence.dataset};
  let draft=await input.store.getTasksetDraft(draftId);
  if(draft&&contentHash(draft.metadata.humanTaskProposal)!==contentHash(lineage))fail("human_task_publication_operation_conflict");
  if(!draft){const temporary=await mkdtemp(path.join(tmpdir(),"human-author-"));try{await cp(source.workspace.workspacePath,temporary,{recursive:true,errorOnExist:false,force:false});await writeTasksetDraftPackage({...source.draft,id:draftId,revision:1,status:"draft",modelScope:null,tasks:applyHumanTaskProposal(source.draft.tasks,proposal),metadata:{...source.draft.metadata,humanTaskProposal:lineage}},temporary);draft=await input.store.importTasksetDraftPackage({packagePath:temporary,profileId:original.profileId});}finally{await rm(temporary,{recursive:true,force:true});}}
  if(draft.status!=="published"){if(contentHash(draft.tasks)!==contentHash(applyHumanTaskProposal(source.draft.tasks,proposal)))fail("human_task_publication_draft_changed");if(!draft.publishedTasksetRef)draft=await input.store.saveTasksetDraft({...draft,publishedTasksetRef:source.draft.publishedTasksetRef},draft.revision);
    const workspace=await input.store.getTasksetDraftWorkspace(draft.id);if(!workspace)fail("human_task_publication_source_missing");const authored=publishTasksetDraft({draft,now:draft.updatedAt,sourcePackageHash:workspace.packageHash}),materialized=await input.store.materializePublishedTasksetPackage({draftId:draft.id,taskset:authored});draft=(await input.store.finalizeTasksetDraftPublication({draft,packageHash:workspace.packageHash,taskset:materialized.taskset})).draft;}
  const ref=draft.publishedTasksetRef??fail("human_task_publication_missing"),taskset=await input.store.getTasksetRevision(ref.id,ref.revision,ref.contentHash);if(!taskset)fail("human_task_publication_missing");
  const releases=materializePortableTasksetRelease({taskset,rewardExecution:await resolveTasksetRewardBinding(input.store,taskset),adapterId:desktopTasksetRuntimeAdapterId(taskset)});
  const value=await captureAuthoredModelTasksetPackage({storeDir:input.storeDir,taskset,content:{schemaVersion:"openpond.tasksetPackage.v1",taskset:releases.tasksetRelease,environment:releases.environmentRelease,verifierSet:releases.verifierSetRelease,...(input.baseline.modelResources?{modelResources:input.baseline.modelResources}:{}),...(input.baseline.learningResources?{learningResources:input.baseline.learningResources}:{})}});
  const before=input.baseline.taskset,after=value.taskset;if(contentHash(applyHumanTaskProposal(before.tasks,proposal))!==contentHash(after.tasks)||["policy","tools","capabilities","graders"].some(key=>contentHash((before as unknown as Record<string,unknown>)[key])!==contentHash((after as unknown as Record<string,unknown>)[key])))fail("human_task_publication_contract_mismatch");
  await cacheTasksetPackage(input.storeDir,value);return value;
}
