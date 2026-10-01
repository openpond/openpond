import path from "node:path";
import {contentHash} from "@openpond/harness";
import {createProfileExternalDatasetBinding,type ProfileExternalDatasetBinding} from "@openpond/evals";
import {loadOpenPondProfileLibrary,loadOpenPondProfileStateForRef} from "@openpond/cloud";
import {OpenPondTasksetPackageClient} from "openpond-sdk/taskset-packages";
import {ConnectedEvidenceClient} from "openpond-sdk/connected-evidence";
import {OpenPondExperimentsClient,verifyExternalDatasetPackage} from "openpond-sdk/experiments";
import type {createExperimentImprovementRuntime} from "./experiment-improvement-runtime.js";
import type {createLocalExperimentService} from "../evaluations/local-experiment-service.js";
import type {SqliteStore} from "../store/store.js";
import type {ImprovementActor} from "./experiment-improvement-service.js";
import {createLocalProfileOriginAdapter} from "../evaluations/local-experiment-profile-origin.js";
import {ensureLocalProfileWorkflows} from "./local-profile-workflow-runtime.js";
import {profileEvaluationsForRelease} from "./local-profile-evaluation-runtime.js";
import {compileLocalHarnessSource} from "./local-harness-workspace-service.js";
import {compiledCandidateExecutableIdentity} from "./experiment-candidate-equivalence.js";
import {localPackageGraders} from "../evaluations/local-experiment-admission.js";
/** Policy-facing choices contain public component labels and hashes, never
 * evaluator bytes. Each recipe is reconstructed from the actual owner package. */
export function createExperimentImprovementOptions(deps:{store:SqliteStore;storeDir:string;runtime:ReturnType<typeof createExperimentImprovementRuntime>;actorId():Promise<string>;teamId():Promise<string>;resolveAccess():Promise<{apiBaseUrl:string;token:string}>;localExperiments():ReturnType<typeof createLocalExperimentService>}){
  return async(actor:ImprovementActor,reference:{id:string;contentHash:string})=>{
    const evidence=await deps.runtime.loadEvidence(actor,reference),access=await deps.resolveAccess(),options={baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:actor.teamId},packages=new OpenPondTasksetPackageClient(options),experiments=new OpenPondExperimentsClient(options),dataset={...evidence.manifest.dataset,revision:Number(evidence.manifest.dataset.revision)};
    const value=await packages.getByRelease(dataset),graders=localPackageGraders(value),splits=new Set(evidence.manifest.population.map(member=>value.taskset.tasks.find(task=>task.id===member.caseId)?.split));if(splits.size!==1||splits.has(undefined))throw new Error("Improve requires an exact single split from its original Dataset evidence.");
    let selected=graders,actualGrading:{pass:unknown;evidence:unknown}|undefined,scoring:import("zod").infer<typeof import("openpond-sdk/experiment-improvements").ExperimentImprovementScoringSchema>|undefined,recordedOrigin:ProfileExternalDatasetBinding["recordedOrigin"];
    if(reference.id.startsWith("local-")){const local=deps.localExperiments(),passId=evidence.manifest.lineage?.scoringPassId;selected=passId?(await local.pass({teamId:actor.teamId,id:passId})).graders:(await local.read({teamId:actor.teamId,id:reference.id})).graders;}
    else if(evidence.manifest.lineage?.scoringPassId){const pass=await experiments.scoringPass(evidence.manifest.lineage.scoringPassId);selected=pass.graders;actualGrading={pass,evidence};scoring={sourcePass:{id:pass.id,contentHash:pass.contentHash},graders:pass.request.graders,mappings:pass.request.mappings,maximumCostUsd:pass.request.maximumCostUsd};
      if(pass.request.executionKind==="recorded_evidence"){const recorded=await new ConnectedEvidenceClient(options).recordedExecution(pass.request.execution.id);recordedOrigin={execution:{id:recorded.id,contentHash:recorded.contentHash},originalEvidence:reference,members:evidence.manifest.population.map(member=>{const matches=recorded.sources.filter(source=>source.boundaryId===member.caseId);if(matches.length!==1||member.fixtureId!==matches[0]!.snapshotHash)throw new Error("The selected original population lacks an exact unique recorded source cutoff.");const source=matches[0]!;return{caseId:member.caseId,seed:member.seed,fixtureId:member.fixtureId,sourceId:source.id,snapshotHash:source.snapshotHash,boundaryRevisionHash:source.boundaryRevisionHash};})};}
    }
    const fieldMappings=selected.map(pin=>({graderId:pin.id,fields:"mappings" in pin&&Array.isArray(pin.mappings)?pin.mappings:[]}));
    const origins=createLocalProfileOriginAdapter({...deps,resolveAccess:async()=>({...await deps.resolveAccess(),actorId:await deps.actorId(),teamId:await deps.teamId()})}),profiles=[];
    for(const entry of (await loadOpenPondProfileLibrary()).profiles.slice(0,100)){
      try{const profile=await loadOpenPondProfileStateForRef(entry.ref),workflows=entry.ref.source==="local"?await ensureLocalProfileWorkflows({...deps,ref:entry.ref,profile,reloadProfile:()=>loadOpenPondProfileStateForRef(entry.ref)}):await origins.workflows(entry.ref),record=await deps.store.getHarnessReleaseRecord(workflows.harnessRelease.contentHash),workspace=record&&await deps.store.getHarnessWorkspace(record.workspaceId);if(!record||!workspace)continue;
        const compiled=await compileLocalHarnessSource({workspaceId:typeof record.agentSnapshot.metadata.workspaceId==="string"?record.agentSnapshot.metadata.workspaceId:workspace.id,sourceDir:path.join(record.bundlePath,"source")}),catalog=await profileEvaluationsForRelease({store:deps.store,ref:entry.ref,sourceRevision:workflows.sourceRevision,harnessRelease:workflows.harnessRelease}),components=[];
        const actionBytes=compiled.sourceFiles.find(file=>file.path==="workflows/actions.json")?.bytes,actions=actionBytes?JSON.parse(Buffer.from(actionBytes).toString("utf8")).actions:[];
        const agentsSelected=new Set<string>();
        const candidates:Array<{kind:"skill"|"instruction"|"agent"|"workflow";path:string;agentId?:string;workflowId?:string}>=compiled.manifest.files.filter(file=>file.visibility==="policy"&&["skill","instruction","agent"].includes(file.kind)&&(file.kind!=="skill"||file.path.endsWith("/SKILL.md"))&&(file.kind!=="agent"||!agentsSelected.has(file.path.split("/")[1]!)&&Boolean(agentsSelected.add(file.path.split("/")[1]!)))).map(file=>({kind:file.kind as "skill"|"instruction"|"agent",path:file.path,...(file.kind==="agent"?{agentId:file.path.split("/")[1]}:{})}));
        for(const row of [...candidates,...workflows.workflows.map(item=>({kind:"workflow" as const,path:"workflows/catalog.json",workflowId:item.workflow.id}))]){
          const target=row.kind==="workflow"?{kind:"workflow" as const,workflowId:row.workflowId!}:row.kind==="skill"?{kind:"skill" as const,skillPath:row.path}:row.kind==="instruction"?{kind:"profile" as const}:actions.find((action:{agentId:string;id:string})=>action.agentId===row.agentId)?{kind:"agent_action" as const,actionId:actions.find((action:{agentId:string;id:string})=>action.agentId===row.agentId).id}:null;if(!target)continue;
          const binding=createProfileExternalDatasetBinding({schemaVersion:"openpond.profileExternalDatasetBinding.v1",dataset,packageHash:value.contentHash,profileId:entry.ref.profileId,target,declaredProfileCatalogHash:catalog.catalogHash,protectedProfileClosureHash:compiledCandidateExecutableIdentity(compiled).protectedClosureHash,...(recordedOrigin?{recordedOrigin}:{}),...(scoring?{gradingSource:{pass:scoring.sourcePass,evidence:reference}}:{}),split:value.taskset.tasks.find(task=>task.id===evidence.manifest.population[0]!.caseId)!.split,population:evidence.manifest.population.map(member=>({taskId:member.caseId,seed:member.seed,fixtureId:recordedOrigin?null:member.fixtureId})),evaluators:evidence.manifest.evaluators.map(row=>{if(!row.configurationHash)throw new Error("The original measurement lacks an exact grader configuration receipt; correct grading and rerun both sides before claiming improvement.");return{...row,configurationHash:row.configurationHash};}),fieldMappings,fieldMappingsHash:contentHash(fieldMappings),environmentHash:contentHash(value.taskset.environment),privateDatasetClosureHash:contentHash(value.files.filter(file=>file.asset.visibility!=="policy").map(file=>file.asset)),criterion:{minimumPassRate:0,requireComplete:true}});
          verifyExternalDatasetPackage({binding,packageValue:value,graders,actualGrading});components.push({...row,label:row.kind==="workflow"?row.workflowId:row.path,binding});
        }
        profiles.push({id:contentHash(entry.ref),name:entry.name,profileRef:entry.ref,ownerWorkspaceId:workspace.id,ownerRevision:workspace.revision,baseRelease:workflows.harnessRelease,profileSourceRevision:workflows.sourceRevision,components});
      }catch{/* Broken/revoked/unqualified owner choices disclose no component source. */}
    }
    if(await deps.actorId()!==actor.actorId||await deps.teamId()!==actor.teamId)throw new Error("The Improve account changed during discovery.");return{teamId:actor.teamId,evidence:reference,...(scoring?{scoring}:{}),profiles};
  };
}
