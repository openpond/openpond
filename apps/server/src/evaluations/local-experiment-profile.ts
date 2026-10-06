import {createHostProfileEvaluationTools} from "../harness/host-profile-evaluation-tools.js";
import type {ProfileExternalDatasetResolver} from "../harness/profile-external-dataset-admission.js";
import { prepareLocalProfileExperiment } from "./local-experiment-profile-preparation.js";
import { contentHash } from "@openpond/harness";
import {ChatAttachmentSchema,CHAT_ATTACHMENT_LIMITS,type Session,type Turn,type OpenPondProfileRef} from "@openpond/contracts";
import {decodeTasksetPackageFile,type TasksetPackage} from "openpond-sdk/taskset-packages";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";
import { createProfileWorkflowEvaluationExecutor } from "../harness/profile-evaluation-turn-executor.js";
import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { harnessExperimentReadToolDeclarations } from "@openpond/evals/experiments";
import { resolveLocalProfileExperimentSource } from "./local-experiment-profile-source.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { LocalExperimentDefinition,LocalExperimentAdmission } from "./local-experiment-contract.js";
import type { ProfileOriginAuthority } from "./local-experiment-profile-origin.js";
import { LocalExperimentError } from "./local-experiment-contract.js";

type Prepared=Awaited<ReturnType<ReturnType<typeof createProfileEvaluationRunPreparationService>>>;
type Stream=typeof streamOpenPondHostedChatTurn;
export type LocalProfileOwner={
  prepare(raw:unknown,teamId:string):Promise<Awaited<ReturnType<typeof prepareLocalProfileExperiment>>>;
  package(configuration:LocalExperimentDefinition["configuration"]):Promise<TasksetPackage>;
  resolve(configuration:LocalExperimentDefinition["configuration"],value:TasksetPackage):Promise<Prepared>;
  execute(input:{executionId:string;admission:LocalExperimentAdmission;configuration:LocalExperimentDefinition["configuration"];package:TasksetPackage;stream:Stream;signal:AbortSignal}):Promise<unknown>;
};

/** Reuse canonical local Profile preparation and the ordinary bound native
 * turn. A hosted capability receipt cannot be relabeled as local execution. */
export function createLocalProfileExperimentOwner(deps:{
  storeDir:string;resolveExternalDataset?:ProfileExternalDatasetResolver;saveOutput:Parameters<typeof createHostProfileEvaluationTools>[0]["saveOutput"];recordOutput:Parameters<typeof createHostProfileEvaluationTools>[0]["recordOutput"];
  authorizeOrigin?:ProfileOriginAuthority;
  resolveProfileRef?:(repositoryId:string,profileId:string,reference:{id:string;contentHash:string})=>Promise<OpenPondProfileRef>;
  store:HarnessStateStore;actorId():Promise<string>;teamId():Promise<string>;
  prepare:ReturnType<typeof createProfileEvaluationRunPreparationService>;
  loadPackage(prepared:Prepared):Promise<TasksetPackage>;
  createSession(request:unknown):Promise<Session>;sendTurn(sessionId:string,request:unknown):Promise<Turn>;
  interruptSessionTurn(sessionId:string,reason?:string):Promise<Turn>;
}) {
  const profileRef=async(repositoryId:string,profileId:string,reference:{id:string;contentHash:string}):Promise<OpenPondProfileRef>=> {
    const release=await deps.store.getHarnessReleaseRecord(reference.contentHash);
    const workspace=release&&await deps.store.getHarnessWorkspace(release.workspaceId);
    if(workspace?.metadata.profileExperimentOrigin!==undefined||workspace?.metadata.experimentCandidateOrigin!==undefined) {
      if(!deps.resolveProfileRef)throw new Error("The Profile origin is not authenticated.");
      return deps.resolveProfileRef(repositoryId,profileId,reference);
    }
    return {source:"local",repositoryId,profileId};
  };
  const sessions=new Map<string,{binding:unknown;stream:Stream;profile:Prepared["profileRef"];source:Prepared["manifest"]["profileEvaluation"];isolated?:ReturnType<typeof createHostProfileEvaluationTools>}>();
  async function resolve(configuration:LocalExperimentDefinition["configuration"],value:TasksetPackage) {
    const policy=configuration.request.policy;
    if(policy.kind!=="hosted_harness")throw new LocalExperimentError("local_profile_policy_required","Select an exact prepared Profile target.",422);
    const actor=await deps.actorId(),team=await deps.teamId();
    if(!actor||team!==configuration.request.teamId)throw new LocalExperimentError("local_workspace_denied","The Profile belongs to another account or workspace.",403);
    const prepared=await deps.prepare({id:`local-profile-${contentHash(configuration).slice(0,40)}`,createdAt:"1970-01-01T00:00:00.000Z",
      profileRef:await profileRef(policy.profileRepositoryId,policy.source.profileId,policy.source.harnessRelease),profileSource:{sourceRevision:policy.source.sourceRevision,harnessRelease:policy.source.harnessRelease},externalDatasetBinding:policy.source.externalDatasetBinding,definitionId:policy.source.definitionId,modelRef:{providerId:"openpond",modelId:policy.modelId},maximumSpendUsd:configuration.maximumCostUsd});
    // Preparation authorizes the accepted Profile reference before any retained
    // workspace/source inspection. Hashes alone never grant source authority.
    await resolveLocalProfileExperimentSource(deps.store,policy.source.harnessRelease,prepared.profileRef,deps.authorizeOrigin);
    if(prepared.manifest.runtimeTarget.placement!=="local"||contentHash(prepared.manifest.profileEvaluation)!==contentHash(policy.source)
      ||prepared.profileRef.repositoryId!==policy.profileRepositoryId||prepared.modelConfigurationHash!==policy.modelConfigurationHash
      ||prepared.manifest.packageHash!==policy.packageHash||value.contentHash!==policy.packageHash
      ||prepared.taskset.contentHash!==value.taskset.contentHash)
      throw new LocalExperimentError("local_profile_source_conflict","Prepare this exact Profile and Dataset through the local runtime before running. Hosted or changed source receipts are not local authority.",422);

    if(value.taskset.environment.kind!=="text"||value.taskset.tools.some(tool=>!["work_exec","work_save_output"].includes(tool.name))||value.taskset.policy.connectedAppScopes.length
      ||value.taskset.capabilities.some(item=>item.required&&item.id!=="private-verifier"&&!(item.id==="tools"&&item.scopes.every(scope=>["work_exec","work_save_output"].includes(scope)&&value.taskset.tools.some(tool=>tool.name===scope)))))
      throw new LocalExperimentError("local_profile_environment_not_qualified","This Profile requires an additional admitted local tool or Work environment.",422);
    const population=configuration.request.population,expected=prepared.manifest.population;
    const keys=new Set(population.map(member=>JSON.stringify([member.taskId,member.seed])));
    if(population.length!==expected.length||keys.size!==expected.length||expected.some(member=>!keys.has(JSON.stringify([member.taskId,member.seed]))))
      throw new LocalExperimentError("local_profile_population_conflict","This Profile evaluation requires its complete declared task and seed population.",422);
    if(await deps.actorId()!==actor||await deps.teamId()!==team)throw new LocalExperimentError("local_workspace_denied","The account changed during Profile source admission.",403);
    return prepared;
  }
  async function execute(input:Parameters<LocalProfileOwner["execute"]>[0]) {
    const prepared=await resolve(input.configuration,input.package),source=prepared.manifest.profileEvaluation!;
    const runtime=await resolveLocalProfileExperimentSource(deps.store,source.harnessRelease,prepared.profileRef,deps.authorizeOrigin);
    harnessExperimentReadToolDeclarations(runtime.release);
    const task=prepared.taskset.tasks.find(task=>task.id===input.admission.taskId)!;
    const attachments=task.artifactRefs.map(ref=>{if(ref.visibility!=="policy"||ref.mediaType!=="application/pdf"||ref.sizeBytes>CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes)throw new Error("The target input needs a bounded policy PDF.");const file=input.package.files.find(file=>contentHash(file.asset)===contentHash(ref));if(!file)throw new Error("The exact policy input artifact is unavailable.");decodeTasksetPackageFile(file);return ChatAttachmentSchema.parse({id:ref.id,name:ref.path.split("/").at(-1)!,kind:"file",mediaType:ref.mediaType,sizeBytes:ref.sizeBytes,contentsBase64:file.base64});});
    const binding={executionId:input.executionId,admissionHash:input.admission.request.admissionHash,source,modelConfigurationHash:input.admission.request.model.configurationHash};
    const signal=input.signal,actorId=await deps.actorId();
    const stream:Stream=async function*(request){
      if(request.model!==input.admission.request.model.modelId)throw new Error("Profile Experiment requested another model.");
      yield* input.stream({...request,maxTokens:input.admission.request.model.maxOutputTokens,temperature:input.admission.request.model.temperature,
        topP:input.admission.request.model.topP,signal:request.signal?AbortSignal.any([signal,request.signal]):signal});
    };
    const external=source.externalDatasetBinding?await deps.resolveExternalDataset?.(source.externalDatasetBinding,{profileRef:prepared.profileRef,sourceRevision:source.sourceRevision,harnessRelease:source.harnessRelease}):undefined;
    if(source.externalDatasetBinding&&!external)throw new Error("The external target has no actual isolated Dataset authority.");
    const isolated=createHostProfileEvaluationTools({storeDir:deps.storeDir,release:runtime.release,getTurn:id=>deps.store.getTurn(id),getSession:async id=>{const session=await deps.store.getSession(id);if(!session)throw new Error("The target Session is unavailable.");return session;},saveOutput:deps.saveOutput,recordOutput:deps.recordOutput,authorize:async params=>{if(params.bindingHash!==(source.externalDatasetBinding?.contentHash??contentHash(source))||params.manifestHash!==prepared.manifest.contentHash||params.taskId!==input.admission.taskId||params.seed!==input.admission.seed)throw new Error("The isolated target requested another exact case.");await external?.authorize();if(await deps.actorId()!==actorId||await deps.teamId()!==input.configuration.request.teamId)throw new Error("The current target workspace changed.");await resolveLocalProfileExperimentSource(deps.store,source.harnessRelease,prepared.profileRef,deps.authorizeOrigin);signal.throwIfAborted();}});
    let sessionId:string|undefined;
    let timedOut=false;
    let overflowHash:string|undefined;
    const executor=createProfileWorkflowEvaluationExecutor({...prepared,attachments,requiredOutputs:task.requiredOutputs??[],createSession:async request=>{
        signal.throwIfAborted();await resolveLocalProfileExperimentSource(deps.store,source.harnessRelease,prepared.profileRef,deps.authorizeOrigin);
        signal.throwIfAborted();return deps.createSession(request);
      },sendTurn:deps.sendTurn,
      interruptSessionTurn:deps.interruptSessionTurn,runtimeEventsForTurn:id=>deps.store.runtimeEventsForTurn(id),
      maximumOutputBytes:262_144,retainOutputLimitEvidence:true,onOutputLimit:hash=>{overflowHash=hash;},validateTerminalTurn:async(session,turn)=>{
        if(turn.sessionId!==session.id||!turn.profileSnapshot||contentHash(turn.profileSnapshot.ref)!==contentHash(prepared.profileRef)
          ||turn.profileSnapshot.revision!==source.sourceRevision||turn.profileSnapshot.sourceHash!==source.harnessRelease.contentHash)
          throw new Error("Local Profile terminal receipt changed its exact source binding.");
        const events=await deps.store.runtimeEventsForTurn(turn.id);
        if(events.some(event=>event.sessionId!==session.id||event.turnId!==turn.id))throw new Error("Profile trace contains another case's evidence.");
      },
      onInterrupt:kind=>{timedOut=kind==="timed_out";},
      assertSpendAuthority:async manifest=>{if(manifest.contentHash!==prepared.manifest.contentHash||manifest.limits.maximumSpendUsd===null)throw new Error("Local Profile spend admission changed.");signal.throwIfAborted();},
      ownedSessionMetadata:{localProfileExperiment:binding},admitSession:async session=>{
        await resolveLocalProfileExperimentSource(deps.store,source.harnessRelease,prepared.profileRef,deps.authorizeOrigin);
        if(contentHash(session.currentProfile)!==contentHash(prepared.profileRef))throw new Error("Local Profile session acquired another Profile.");
        await ensureLocalHarnessRunOverlay({store:deps.store,runId:session.id,workspace:runtime.workspace,harnessRelease:source.harnessRelease,admittedAt:session.createdAt});
        sessionId=session.id;if(isolated)await isolated.admitSession(session,prepared.manifest,input.admission.taskId,input.admission.seed,attachments);sessions.set(session.id,{binding,stream,profile:prepared.profileRef,source,isolated});
      }});
    try {
      const result=await executor({task:{id:task.id,input:input.admission.request.input,policyVisibleContext:input.admission.request.policyVisibleContext,artifactRefs:task.artifactRefs,tags:task.tags},seed:input.admission.seed,source,signal});
      const output=overflowHash?null:result.evidence.output?.text??null;
      const body={schemaVersion:"openpond.localProfileExperimentAttempt.v1",taskId:task.id,status:signal.aborted?"cancelled":timedOut?"timed_out":result.terminal?"completed":"policy_failure",
        output,error:result.evidence.infrastructureError??null,messages:[],environmentCleanupComplete:true,collected:result.terminal,snapshot:null,
        artifactRefs:result.artifactRefs,
        profileNative:{...result.retainedEvidenceRef,source,profileRef:prepared.profileRef,admissionHash:input.admission.request.admissionHash,
          modelConfigurationHash:input.admission.request.model.configurationHash,traceHash:result.traceHash,runtimeEventRefs:result.evidence.runtimeEventRefs,
          startedAt:result.startedAt,completedAt:result.completedAt,outputHash:overflowHash??contentHash(output??""),partialOutputAvailable:overflowHash!==undefined||!result.terminal&&Boolean(output)}};
      return {...body,contentHash:contentHash(body)};
    } finally {if(sessionId)sessions.delete(sessionId);isolated?.close();}
  }
  return {profile:{resolve,execute,prepare:(raw,teamId)=>prepareLocalProfileExperiment({raw,teamId,prepare:deps.prepare,loadPackage:deps.loadPackage,resolve}),
    package:async(configuration)=>{
      const policy=configuration.request.policy;if(policy.kind!=="hosted_harness")throw new Error("An exact Profile policy is required.");
      const prepared=await deps.prepare({id:`local-profile-package-${contentHash(configuration).slice(0,40)}`,createdAt:"1970-01-01T00:00:00.000Z",
        profileRef:await profileRef(policy.profileRepositoryId,policy.source.profileId,policy.source.harnessRelease),profileSource:{sourceRevision:policy.source.sourceRevision,harnessRelease:policy.source.harnessRelease},externalDatasetBinding:policy.source.externalDatasetBinding,definitionId:policy.source.definitionId,modelRef:{providerId:"openpond",modelId:policy.modelId},maximumSpendUsd:configuration.maximumCostUsd});
      const value=await deps.loadPackage(prepared);await resolve(configuration,value);return value;
    }} satisfies LocalProfileOwner,async isolatedProfileEvaluationForTurn(session:Session){if(session.metadata?.localProfileExperiment===undefined)return false;const owner=sessions.get(session.id);if(!owner)throw new Error("This target Session has no actual admitted case owner.");return Boolean(owner.isolated);},
    async resolveModelTools(context:Parameters<import("../runtime/app-server-embedding.js").ResolveAppServerModelTools>[0]){if(context.session.metadata?.localProfileExperiment===undefined)return null;const owner=sessions.get(context.session.id);if(!owner)throw new Error("This target Session has no actual admitted case owner.");return owner.isolated?owner.isolated.resolveTools(context):null;},
    async executeProfileEvaluationAction(action:Parameters<ReturnType<typeof createHostProfileEvaluationTools>["executeAction"]>[0]){const owner=sessions.get(action.session.id);if(!owner?.isolated)throw new Error("This initial target Agent action has no actual isolated case owner.");return owner.isolated.executeAction(action);},
    close(){for(const value of sessions.values())value.isolated?.close();sessions.clear();},
    async resolveSessionModelStream(session:Session,turn:Turn):Promise<Stream|null>{
    const binding=session.metadata?.localProfileExperiment;if(binding===undefined)return null;
    const owner=sessions.get(session.id);
    if(!owner||contentHash(binding)!==contentHash(owner.binding)||contentHash(session.currentProfile)!==contentHash(owner.profile)
      ||turn.sessionId!==session.id||!turn.profileSnapshot||contentHash(turn.profileSnapshot.ref)!==contentHash(owner.profile)
      ||turn.profileSnapshot.revision!==owner.source?.sourceRevision||turn.profileSnapshot.sourceHash!==owner.source.harnessRelease.contentHash)
      throw new Error("Local Profile Experiment has no matching active execution owner.");
    return owner.stream;
  }};
}
