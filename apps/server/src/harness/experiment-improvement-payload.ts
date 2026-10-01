import {promises as fs} from "node:fs";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {sha256} from "@openpond/harness";
import type {Session,Turn} from "@openpond/contracts";
import {ExperimentImprovementCommandSchema} from "openpond-sdk/experiment-improvements";
import type {SqliteStore} from "../store/store.js";
import type {StoredTurnAdmission} from "../runtime/turns/privileged-admission.js";
import type {createExperimentImprovementRuntime} from "./experiment-improvement-runtime.js";
import type {createLocalExperimentService} from "../evaluations/local-experiment-service.js";
import {createExperimentImprovementOptions} from "./experiment-improvement-options.js";
import {createExperimentImprovementTesting} from "./experiment-improvement-testing.js";
import {resolveContainedRegularFile} from "./local-harness-workspace-files.js";
/** Authenticated device owner transport. Privileged admission is an in-process
 * callback, never an API-supplied metadata capability. */
export function createExperimentImprovementPayload(deps:{runtime:ReturnType<typeof createExperimentImprovementRuntime>;store:SqliteStore;storeDir:string;resolveAccess():Promise<{apiBaseUrl:string;token:string}>;actorId():Promise<string>;teamId():Promise<string>;
  createSession(raw:unknown):Promise<Session>;sendTurn(sessionId:string,raw:unknown,reservedTurnId?:string,admission?:StoredTurnAdmission):Promise<Turn>;
  interruptSessionTurn(sessionId:string,reason?:string):Promise<Turn>;localExperiments():ReturnType<typeof createLocalExperimentService>}){
  const service=deps.runtime.service,testing=createExperimentImprovementTesting({improvements:service,localExperiments:deps.localExperiments,resolveAccess:deps.resolveAccess}),active=new Map<string,Promise<Turn>>(),options=createExperimentImprovementOptions(deps);
  return async function payload(raw:unknown){const envelope=z.object({teamId:z.string().min(1),request:ExperimentImprovementCommandSchema}).strict().parse(raw),request=envelope.request,actor={actorId:await deps.actorId(),teamId:await deps.teamId()};if(!actor.actorId||actor.teamId!==envelope.teamId)throw new Error("Select the signed-in Improve workspace.");
    if(request.operation==="options")return options(actor,request.evidence);
    if(request.operation==="list")return service.list(actor,request.limit,request.cursor);
    if(request.operation==="start")return service.start(actor,request.request);
    let state=await service.read(actor,request.id);
    if(request.operation==="read"){if(state.status==="authoring"&&state.work){const turn=await deps.store.getTurn(state.work.turnId);if(turn&&turn.status!=="in_progress")state=await service.finishAuthoring(actor,state.id,state.revision);}if(state.status==="testing")state=await testing.settle(actor,state);if(state.status==="adopting"&&state.adoptionIntent)state=await service.useCandidate(actor,state.id,state.revision);return state;}
    if(request.operation==="humanComparisonOptions")return testing.readComparison(actor,state);
    if(request.operation==="instructions"){const partition=await service.partition(actor,state.id),file=await resolveContainedRegularFile(partition.sourceRoot,state.component.path),bytes=await fs.readFile(file);if(bytes.length>250000)throw new Error("The selected instruction source exceeds the editor size limit.");let text=bytes.toString("utf8");if(state.component.kind==="workflow"){const catalog=JSON.parse(text),workflow=catalog.workflows?.find((row:{id:string})=>row.id===state.component.workflowId);if(workflow?.invocation?.kind!=="instructions")throw new Error("This Workflow requires code authoring through Work.");text=workflow.invocation.instructions;}return{candidateId:state.id,candidateRevision:state.revision,path:state.component.path,text,textHash:sha256(text),contentHash:sha256(bytes)};}
    if(!("revision" in request)||state.revision!==request.revision)throw new Error("The candidate changed; reload its current revision.");
    if(request.operation==="mode")return service.setMode(actor,state.id,request.revision,request.mode);
    if(request.operation==="edit")return service.edit(actor,state.id,request.revision,request.expectedFileHash,request.text);
    if(request.operation==="freeze")return service.freeze(actor,state.id,state.revision);
    if(request.operation==="finishAuthoring")return service.finishAuthoring(actor,state.id,state.revision);
    if(request.operation==="useCandidate")return service.useCandidate(actor,state.id,state.revision);
    if(request.operation==="rollback")return service.rollback(actor,state.id,state.revision);
    if(request.operation==="discard")return service.discard(actor,state.id,state.revision);
    if(request.operation==="cancel"){if(state.status==="authoring"&&state.work){await deps.interruptSessionTurn(state.work.sessionId,"The owner cancelled candidate authoring.");state=await service.finishAuthoring(actor,state.id,(await service.read(actor,state.id)).revision);}if(state.status==="testing"){state=await service.cancelTesting(actor,state.id,state.revision);await testing.cancel(state);return testing.settle(actor,state);}return service.discard(actor,state.id,state.revision,true);}
    if(request.operation==="compare"){const result=await deps.localExperiments().compare({teamId:actor.teamId,baselineId:request.baseline.id,candidateId:request.candidate.id});if(result.baseline.result.contentHash!==request.baseline.contentHash||result.candidate.result.contentHash!==request.candidate.contentHash)throw new Error("The compared execution evidence changed.");return service.completeComparison(actor,state.id,state.revision,result.baseline,result.candidate,request.humanSelections);}
    if(request.operation==="test"){state=await service.beginTesting(actor,state.id,state.revision,request.recipe);await testing.execute(state,"baseline");await testing.execute(state,"candidate");return service.read(actor,state.id);}
    if(request.operation==="author"){
      if(state.mode!=="llm_assisted"||state.status!=="draft"||active.has(state.id))throw new Error("Start authoring only a settled LLM candidate draft.");
      const partition=await service.partition(actor,state.id),session=await deps.createSession({experience:"work",provider:"openpond",modelRef:{providerId:"openpond",modelId:request.modelId},title:`Improve ${state.component.kind}`,hiddenFromDefaultSidebar:true,cwd:partition.sourceRoot,currentProfile:state.profileRef,cloudTeamId:actor.teamId,metadata:{source:"experiment-improvement",candidateId:state.id}}),turnId=randomUUID();
      let admit!:()=>void,reject!:(error:unknown)=>void;const admitted=new Promise<void>((resolve,rejectValue)=>{admit=resolve;reject=rejectValue;});
      const pending=deps.sendTurn(session.id,{prompt:request.prompt,modelRef:{providerId:"openpond",modelId:request.modelId}},turnId,{beforeExecute:async(actualSession,turn)=>{if(actualSession.id!==session.id||turn.id!==turnId)throw new Error("The actual candidate Work admission changed.");const marker={candidateId:state.id,authoringRevision:state.revision+1,...actor};turn.metadata={...turn.metadata,source:"experiment-improvement",refinementCandidate:marker};await deps.store.updateTurn(turn.id,current=>({...current,metadata:{...current.metadata,source:"experiment-improvement",refinementCandidate:marker}}));await service.bindAuthoringTurn(actor,state.id,state.revision,session.id,turnId);admit();}});
      active.set(state.id,pending);void pending.catch(reject).finally(async()=>{active.delete(state.id);const current=await service.read(actor,state.id).catch(()=>null);if(current?.status==="authoring")await service.finishAuthoring(actor,current.id,current.revision).catch(()=>undefined);});await admitted;return service.read(actor,state.id);
    }
    throw new Error("Unknown Improve lifecycle operation.");
  };
}
