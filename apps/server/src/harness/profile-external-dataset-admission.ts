import {contentHash} from "@openpond/harness";
import {assertProfileEvaluationRunAdmission,externalDatasetDefinitionId,verifyProfileExternalDatasetBinding,type ProfileExternalDatasetBinding,type ProfileEvaluationDefinition,type TasksetRunManifest,type TasksetRelease} from "@openpond/evals";
import type {OpenPondProfileRef} from "@openpond/contracts";
import {validateTasksetPackage,type TasksetPackage} from "openpond-sdk/taskset-packages";
import type {ProfileEvaluationCatalogSource} from "./local-profile-evaluation-runtime.js";
export type ExternalDatasetProfileSelection={profileRef:OpenPondProfileRef;sourceRevision:string;harnessRelease:{id:string;contentHash:string}};
export type ProfileExternalDatasetResolver=(binding:ProfileExternalDatasetBinding,selected:ExternalDatasetProfileSelection)=>Promise<{binding:ProfileExternalDatasetBinding;packageValue:TasksetPackage;authorize():Promise<void>}>;
export function externalProfileEvaluationDefinition(binding:ProfileExternalDatasetBinding):ProfileEvaluationDefinition{return {id:externalDatasetDefinitionId(binding),label:"Selected Dataset evaluation",description:"Explicit sealed external Dataset evaluation recipe.",target:binding.target,tasksetRelease:{id:binding.dataset.id,contentHash:binding.dataset.contentHash},split:binding.split,taskIds:[...new Set(binding.population.map(row=>row.taskId))],seeds:[...new Set(binding.population.map(row=>row.seed))],criterion:binding.criterion};}
/** An identity in a manifest cannot authorize external files. Resolve their
 * actual owner again and bind the declared Profile closure and ordered recipe. */
export async function admitProfileExternalDataset(input:{manifest:TasksetRunManifest;taskset:TasksetRelease;selected:ExternalDatasetProfileSelection;loadCatalog:ProfileEvaluationCatalogSource;resolveExternalDataset?:ProfileExternalDatasetResolver}){
 const source=input.manifest.profileEvaluation,binding=source?.externalDatasetBinding?verifyProfileExternalDatasetBinding(source.externalDatasetBinding):null;if(!binding)return null;
 if(!input.resolveExternalDataset)throw new Error("This owner has no authorized external Dataset resolver.");
 const admitted=await input.resolveExternalDataset(binding,input.selected);await admitted.authorize();const value=validateTasksetPackage(admitted.packageValue);
 const discovered=await input.loadCatalog({ref:input.selected.profileRef,sourceRevision:input.selected.sourceRevision,harnessRelease:input.selected.harnessRelease});
 if(contentHash(admitted.binding)!==contentHash(binding)||binding.profileId!==input.selected.profileRef.profileId||binding.declaredProfileCatalogHash!==discovered.catalogHash||value.contentHash!==binding.packageHash||contentHash(value.taskset)!==contentHash(input.taskset)||binding.environmentHash!==contentHash(value.taskset.environment)||binding.privateDatasetClosureHash!==contentHash(value.files.filter(file=>file.asset.visibility!=="policy").map(file=>file.asset)))throw new Error("External Dataset admission changed its actual Profile, package or private closure.");
 const definition=externalProfileEvaluationDefinition(binding),catalog={schemaVersion:"openpond.profileEvaluations.v1" as const,definitions:[definition],suites:[]};assertProfileEvaluationRunAdmission(input.manifest,input.taskset,catalog);
 if(!source||source.catalogHash!==contentHash(catalog)||source.definitionHash!==contentHash(definition)||contentHash(source.target)!==contentHash(binding.target))throw new Error("External Dataset manifest changed its derived definition.");
 await admitted.authorize();return {...admitted,packageValue:value,definition,catalog};
}
