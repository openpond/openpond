import { prepareLocalProfileExperiment } from "./local-experiment-profile-preparation.js";
import { contentHash } from "@openpond/harness";
import type { Session,Turn } from "@openpond/contracts";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";
import { createProfileWorkflowEvaluationExecutor } from "../harness/profile-evaluation-turn-executor.js";
import { ensureLocalHarnessRunOverlay } from "../harness/local-harness-run-overlay.js";
import { harnessExperimentReadToolDeclarations } from "@openpond/evals/experiments";
import { resolveLocalProfileExperimentSource } from "./local-experiment-profile-source.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { LocalExperimentDefinition,LocalExperimentAdmission } from "./local-experiment-contract.js";
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
  store:HarnessStateStore;actorId():Promise<string>;teamId():Promise<string>;
  prepare:ReturnType<typeof createProfileEvaluationRunPreparationService>;
  loadPackage(prepared:Prepared):Promise<TasksetPackage>;
  createSession(request:unknown):Promise<Session>;sendTurn(sessionId:string,request:unknown):Promise<Turn>;
  interruptSessionTurn(sessionId:string,reason?:string):Promise<Turn>;
}) {
  const sessions=new Map<string,{binding:unknown;stream:Stream;profile:Prepared["profileRef"];source:Prepared["manifest"]["profileEvaluation"]}>();
  async function resolve(configuration:LocalExperimentDefinition["configuration"],value:TasksetPackage) {
    const policy=configuration.request.policy;
    if(policy.kind!=="hosted_harness")throw new LocalExperimentError("local_profile_policy_required","Select an exact prepared Profile target.",422);
    const actor=await deps.actorId(),team=await deps.teamId();
    if(!actor||team!==configuration.request.teamId)throw new LocalExperimentError("local_workspace_denied","The Profile belongs to another account or workspace.",403);
    const prepared=await deps.prepare({id:`local-profile-${contentHash(configuration).slice(0,40)}`,createdAt:"1970-01-01T00:00:00.000Z",
      profileRef:{source:"local",repositoryId:policy.profileRepositoryId,profileId:policy.source.profileId},profileSource:{sourceRevision:policy.source.sourceRevision,harnessRelease:policy.source.harnessRelease},definitionId:policy.source.definitionId,modelRef:{providerId:"openpond",modelId:policy.modelId},maximumSpendUsd:configuration.maximumCostUsd});
    // Preparation authorizes the accepted Profile reference before any retained
    // workspace/source inspection. Hashes alone never grant source authority.
    await resolveLocalProfileExperimentSource(deps.store,policy.source.harnessRelease,prepared.profileRef);
    if(prepared.manifest.runtimeTarget.placement!=="local"||contentHash(prepared.manifest.profileEvaluation)!==contentHash(policy.source)
      ||prepared.profileRef.repositoryId!==policy.profileRepositoryId||prepared.modelConfigurationHash!==policy.modelConfigurationHash
      ||prepared.manifest.packageHash!==policy.packageHash||value.contentHash!==policy.packageHash
      ||prepared.taskset.contentHash!==value.taskset.contentHash)
      throw new LocalExperimentError("local_profile_source_conflict","Prepare this exact Profile and Dataset through the local runtime before running. Hosted or changed source receipts are not local authority.",422);
    if(prepared.profileRef.source!=="local")throw new LocalExperimentError("local_profile_origin_not_qualified","This Profile requires a currently authenticated remote origin owner before local execution.",422);
    if(value.taskset.environment.kind!=="text"||value.taskset.tools.length||value.taskset.policy.connectedAppScopes.length
      ||value.taskset.capabilities.some(item=>item.required)||value.taskset.tasks.some(task=>task.artifactRefs.length||task.requiredOutputs?.length))
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
    const runtime=await resolveLocalProfileExperimentSource(deps.store,source.harnessRelease,prepared.profileRef);
    harnessExperimentReadToolDeclarations(runtime.release);
    const binding={executionId:input.executionId,admissionHash:input.admission.request.admissionHash,source,modelConfigurationHash:input.admission.request.model.configurationHash};
    const signal=input.signal;
    const stream:Stream=async function*(request){
      if(request.model!==input.admission.request.model.modelId)throw new Error("Profile Experiment requested another model.");
      yield* input.stream({...request,maxTokens:input.admission.request.model.maxOutputTokens,temperature:input.admission.request.model.temperature,
        topP:input.admission.request.model.topP,signal:request.signal?AbortSignal.any([signal,request.signal]):signal});
    };
    let sessionId:string|undefined;
    let timedOut=false;
    let overflowHash:string|undefined;
    const executor=createProfileWorkflowEvaluationExecutor({...prepared,createSession:deps.createSession,sendTurn:deps.sendTurn,
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
        if(contentHash(session.currentProfile)!==contentHash(prepared.profileRef))throw new Error("Local Profile session acquired another Profile.");
        await ensureLocalHarnessRunOverlay({store:deps.store,runId:session.id,workspace:runtime.workspace,harnessRelease:source.harnessRelease,admittedAt:session.createdAt});
        sessionId=session.id;sessions.set(session.id,{binding,stream,profile:prepared.profileRef,source});
      }});
    try {
      const task=prepared.taskset.tasks.find(task=>task.id===input.admission.taskId)!;
      const result=await executor({task:{id:task.id,input:input.admission.request.input,policyVisibleContext:input.admission.request.policyVisibleContext,artifactRefs:[],tags:task.tags},seed:input.admission.seed,source,signal});
      const output=overflowHash?null:result.evidence.output?.text??null;
      const body={schemaVersion:"openpond.localProfileExperimentAttempt.v1",taskId:task.id,status:signal.aborted?"cancelled":timedOut?"timed_out":result.terminal?"completed":"policy_failure",
        output,error:result.evidence.infrastructureError??null,messages:[],environmentCleanupComplete:true,collected:result.terminal,snapshot:null,
        profileNative:{...result.retainedEvidenceRef,source,profileRef:prepared.profileRef,admissionHash:input.admission.request.admissionHash,
          modelConfigurationHash:input.admission.request.model.configurationHash,traceHash:result.traceHash,runtimeEventRefs:result.evidence.runtimeEventRefs,
          startedAt:result.startedAt,completedAt:result.completedAt,outputHash:overflowHash??contentHash(output??""),partialOutputAvailable:overflowHash!==undefined||!result.terminal&&Boolean(output)}};
      return {...body,contentHash:contentHash(body)};
    } finally {if(sessionId)sessions.delete(sessionId);}
  }
  return {profile:{resolve,execute,prepare:(raw,teamId)=>prepareLocalProfileExperiment({raw,teamId,prepare:deps.prepare,loadPackage:deps.loadPackage,resolve}),
    package:async(configuration)=>{
      const policy=configuration.request.policy;if(policy.kind!=="hosted_harness")throw new Error("An exact Profile policy is required.");
      const prepared=await deps.prepare({id:`local-profile-package-${contentHash(configuration).slice(0,40)}`,createdAt:"1970-01-01T00:00:00.000Z",
        profileRef:{source:"local",repositoryId:policy.profileRepositoryId,profileId:policy.source.profileId},profileSource:{sourceRevision:policy.source.sourceRevision,harnessRelease:policy.source.harnessRelease},definitionId:policy.source.definitionId,modelRef:{providerId:"openpond",modelId:policy.modelId},maximumSpendUsd:configuration.maximumCostUsd});
      const value=await deps.loadPackage(prepared);await resolve(configuration,value);return value;
    }} satisfies LocalProfileOwner,async resolveSessionModelStream(session:Session,turn:Turn):Promise<Stream|null>{
    const binding=session.metadata?.localProfileExperiment;if(binding===undefined)return null;
    const owner=sessions.get(session.id);
    if(!owner||contentHash(binding)!==contentHash(owner.binding)||contentHash(session.currentProfile)!==contentHash(owner.profile)
      ||turn.sessionId!==session.id||!turn.profileSnapshot||contentHash(turn.profileSnapshot.ref)!==contentHash(owner.profile)
      ||turn.profileSnapshot.revision!==owner.source?.sourceRevision||turn.profileSnapshot.sourceHash!==owner.source.harnessRelease.contentHash)
      throw new Error("Local Profile Experiment has no matching active execution owner.");
    return owner.stream;
  }};
}
