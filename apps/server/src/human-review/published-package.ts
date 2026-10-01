import {contentHash} from "@openpond/harness";
import {HumanReviewSchema,type HumanReview} from "@openpond/evals/human-review";
import {LearningDomainError} from "@openpond/evals/learning";
import type {SqliteStore} from "../store/store.js";
import type {TasksetPackage} from "openpond-sdk/taskset-packages";
import {publishLocalHumanTaskProposal} from "./task-publication.js";
/** Resolve already published, actual authoring bytes. This read cannot create
 * a missing draft or grant another account access to local evidence. */
export async function resolveLocalHumanPublishedPackage(input:{store:SqliteStore;storeDir:string;scope:string;actorId:string;projectId:string;release:{id:string;revision:number;contentHash:string};loadBaseline:(release:{id:string;revision:number;contentHash:string})=>Promise<TasksetPackage>;ancestors?:Set<string>}):Promise<TasksetPackage|null>{
  const identity=contentHash(input.release),ancestors=new Set(input.ancestors);if(ancestors.has(identity)||ancestors.size>=100)throw new LearningDomainError("human_task_publication_lineage_cycle",409);ancestors.add(identity);
  const records=await input.store.humanReviewRepository().transaction(input.scope,async tx=>{const found:HumanReview[]=[];let afterId:string|undefined;do{const page=await tx.list({projectId:input.projectId,afterId,limit:100});found.push(...page.items.filter(row=>row.authorPublication&&contentHash(row.authorPublication.dataset)===identity));afterId=page.nextCursor??undefined;}while(afterId);return found;});
  if(!records.length)return null;if(records.length!==1)throw new LearningDomainError("human_task_publication_identity_conflict",409);
  const review=HumanReviewSchema.parse(records[0]!),{contentHash:hash,...content}=review;
  if(hash!==contentHash(content)||review.scope!==input.scope||review.projectId!==input.projectId||review.createdBy!==input.actorId||review.authorPublication?.publishedBy!==input.actorId)throw new LearningDomainError("human_task_publication_source_denied",403);
  const proposalHash=review.authorPublication.proposalHash,draftId=`human-author-${contentHash([input.actorId,input.scope,review.id,proposalHash])}`,draft=await input.store.getTasksetDraft(draftId);if(!draft||draft.status!=="published")throw new LearningDomainError("human_task_publication_source_unavailable",409);
  const baseline=await resolveLocalHumanPublishedPackage({...input,release:review.evidence.dataset,ancestors})??await input.loadBaseline(review.evidence.dataset);
  const value=await publishLocalHumanTaskProposal({store:input.store,storeDir:input.storeDir,actorId:input.actorId,review,proposalHash,baseline});
  if(contentHash({id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash})!==identity)throw new LearningDomainError("human_task_publication_release_changed",409);return value;
}
