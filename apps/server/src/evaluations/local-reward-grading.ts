import {z} from "zod";
import {contentHash} from "@openpond/harness";
import {compileBoundGraders,createRewardBinding,RewardBindingSchema,RewardReleaseSchema,feedbackKeyForReward} from "@openpond/evals/rewards";
import {LearningTextAssetSchema,learningRef,verifyLearningTextAsset} from "@openpond/evals/learning";
import {OpenPondLearningClient} from "openpond-sdk/learning";
import {ExperimentScoringRequestSchema} from "openpond-sdk/experiments";
import type {LocalExperimentDefinition} from "./local-experiment-contract.js";
export const SelectedRewardClosureSchema=z.object({schemaVersion:z.literal("openpond.localSelectedRewardClosure.v1"),binding:RewardBindingSchema,rewards:z.array(RewardReleaseSchema).min(1).max(100),assets:z.array(LearningTextAssetSchema).max(1000),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SelectedRewardClosure=z.infer<typeof SelectedRewardClosureSchema>;
export function verifySelectedRewardClosure(value:unknown){const closure=SelectedRewardClosureSchema.parse(value),{contentHash:hash,...body}=closure;if(contentHash(body)!==hash)throw new Error("The retained selected Reward closure changed.");const specs=compileBoundGraders(closure.binding,closure.rewards);if(specs.some(spec=>spec.kind==="model_judge"&&spec.calibrationStatus!=="passed"))throw new Error("Select calibrated model judge releases before dispatch.");for(const spec of specs){const ref="verifierRef" in spec?spec.verifierRef:"rubricRef" in spec?spec.rubricRef:null;if(ref){const asset=closure.assets.find(asset=>asset.id===ref.id);if(!asset)throw new Error("The selected private Reward asset is unavailable.");verifyLearningTextAsset(asset,ref);}}return{closure,specs};}
export function selectedRewardPins(value:SelectedRewardClosure,mappings:z.infer<typeof ExperimentScoringRequestSchema>["mappings"]):LocalExperimentDefinition["graders"]{const {specs}=verifySelectedRewardClosure(value);return specs.map((spec,index)=>({id:spec.id,version:spec.version,contentHash:contentHash(spec),feedbackKey:feedbackKeyForReward(value.rewards[index]!),release:learningRef(value.rewards[index]!),name:value.rewards[index]!.name,mappings:mappings?.find(row=>row.graderId===spec.id)?.fields??[]}));}
/** This current remote Learning owner supplies exact Reward implementations;
 * no derived Dataset or browser-authored implementation replaces the source. */
export function createLocalRewardGradingResolver(deps:{identity():Promise<{actorId:string;teamId:string}>;resolveAccess():Promise<{apiBaseUrl:string;token:string}>}){
 return async(teamId:string,ownerActorId:string,selection:Pick<z.infer<typeof ExperimentScoringRequestSchema>,"graders"|"mappings">)=>{
 const actor=await deps.identity(),access=await deps.resolveAccess();if(actor.teamId!==teamId||actor.actorId!==ownerActorId)throw new Error("The selected Reward account changed.");
 async function current(){if(contentHash(await deps.identity())!==contentHash(actor)||contentHash(await deps.resolveAccess())!==contentHash(access))throw new Error("The selected Reward connection changed.");}
 const client=new OpenPondLearningClient({apiKey:access.token,baseUrl:access.apiBaseUrl,scope:teamId});
 async function read(){await current();const rewards=await Promise.all(selection.graders.map(async pin=>{const reward=await client.get("reward",pin.id,pin.revision);if(contentHash(learningRef(reward))!==contentHash(pin))throw new Error("The selected Reward release changed.");return reward;}));
 const binding=createRewardBinding({schemaVersion:"openpond.rewardBinding.v1",id:`local-selected-${contentHash(selection).slice(0,40)}`,revision:1,aggregation:"weighted_mean",unscorable:"exclude_optional_require_all_required",sources:rewards.map(reward=>({graderId:reward.id,reward:learningRef(reward),role:"evaluation",normalization:{kind:"identity"},weight:1,required:true,hardGate:false,privileged:true,fixtureRefs:[]}))},rewards),specs=compileBoundGraders(binding,rewards),refs=specs.flatMap(spec=>"verifierRef" in spec?[spec.verifierRef]:"rubricRef" in spec?[spec.rubricRef]:[]),assets:z.infer<typeof LearningTextAssetSchema>[]=[];
 for(const ref of refs){const asset=await client.get("asset",ref.id,1);verifyLearningTextAsset(asset,ref);if(!assets.some(item=>item.id===asset.id))assets.push(asset);}
 const body={schemaVersion:"openpond.localSelectedRewardClosure.v1" as const,binding,rewards,assets},closure=verifySelectedRewardClosure({...body,contentHash:contentHash(body)}).closure;await current();return closure;}
 const closure=await read();return{closure,graders:selectedRewardPins(closure,selection.mappings),authorize:async()=>{if(contentHash(await read())!==contentHash(closure))throw new Error("The selected Reward authority changed.");}};
 };
}
export type LocalRewardGradingResolver=ReturnType<typeof createLocalRewardGradingResolver>;
