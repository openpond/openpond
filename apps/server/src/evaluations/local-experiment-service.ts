import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { LocalExperimentRetainedScoreSchema, LocalExperimentSourceChoicesSchema, LocalExperimentRecordReadSchema, type LocalExperimentRecord, type LocalExperimentSourceChoices } from "@openpond/contracts";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { streamOpenPondHostedChatTurn, type loadOpenPondHostedModels } from "@openpond/runtime";
import type { SqliteLocalExperimentStore } from "../store/store-local-experiments.js";
import { createExperimentCaseService } from "./experiment-case-service.js";
import { createLocalExperimentPolicy } from "./local-experiment-policy.js";
import { createLocalBudgetedModelStream, type LocalModelAdmission } from "./local-experiment-model.js";
import { localRetainedAttempt, localRetainedCase, sealLocalRetainedCase, localEvaluatorContext } from "./local-experiment-output.js";
import { gradeLocalExperimentCase } from "./local-experiment-grading.js";
import { createLearningHostedJudgeProvider } from "../training/learning-hosted-judge-provider.js";
import { createLocalExperimentRunAdmission } from "./local-experiment-run-admission.js";
import { createLocalExperimentScoring } from "./local-experiment-scoring.js";
import { experimentFeedbackSummary,createFeedbackSummaryReader } from "./experiment-feedback-summary.js";
import { localPortableExperiment } from "./local-experiment-portable.js";
import { admitLocalNativeHarness, type QualifiedLocalNativeHarness } from "./local-experiment-native.js";
import type { LocalProfileOwner } from "./local-experiment-profile.js";
import type { LocalEnvironmentOwner } from "./local-experiment-environment.js";
import { LocalExperimentSaveFromReleaseSchema, LocalExperimentReadSchema, LocalExperimentListSchema,
  LocalExperimentError,
  type LocalExperimentExecution, type LocalExperimentAdmission } from "./local-experiment-contract.js";

export function createLocalExperimentService(deps:{store:SqliteLocalExperimentStore;teamId:()=>Promise<string>;actorId:()=>Promise<string>;
  stream?:typeof streamOpenPondHostedChatTurn;catalog?:typeof loadOpenPondHostedModels;ownerId?:string;
  nativeHarness?:QualifiedLocalNativeHarness;
  sourceChoices?:()=>Promise<LocalExperimentSourceChoices>;
  sourceDataset?:(payload:unknown,teamId:string)=>Promise<unknown>;
  environment?:LocalEnvironmentOwner;
  profile?:LocalProfileOwner;
  authorizeProject?:(configuration:import("./local-experiment-contract.js").LocalExperimentDefinition["configuration"])=>Promise<void>;
  resolvePackage?:(input:z.infer<typeof LocalExperimentSaveFromReleaseSchema>)=>Promise<TasksetPackage>}) {
  const ownerId=deps.ownerId??randomUUID(),active=new Map<string,Promise<void>>();
  const controllers=new Map<string,AbortController>();
  const projectScope=new AsyncLocalStorage<string|null>();
  const scopes=new Map<string,{execution:LocalExperimentExecution;admission:LocalExperimentAdmission;model:LocalModelAdmission}>();
  let closing=false;
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  const cases=createExperimentCaseService({
    resolvePolicy:async request=> {
      const scope=scopes.get(request.id);
      if(!scope || contentHash(scope.admission.request)!==contentHash(request))throw new LocalExperimentError("local_case_admission_missing","Only the durable local execution owner may dispatch a case.");
      return createLocalExperimentPolicy({request,stream:createLocalBudgetedModelStream({store:deps.store,ownerId,
        teamId:scope.execution.teamId,executionId:scope.execution.id,caseId:scope.admission.receiptId,admission:scope.model,stream:streamForActor(scope.execution.ownerActorId,scope.execution.teamId)})});
    },
    executeProfile:async()=>{throw new LocalExperimentError("local_profile_not_qualified","Profile targets require the shared released-target adapter.",422);},
    resolveEnvironment:deps.environment?async request=> {
      const scope=scopes.get(request.id);
      if(!scope||contentHash(scope.admission.request)!==contentHash(request)||!deps.environment)
        throw new LocalExperimentError("local_environment_owner_missing","Only the durable case owner may resolve this exact environment.",422);
      return deps.environment.resolve(request,payload=>deps.store.appendLocalExperimentEvent({teamId:scope.execution.teamId,id:scope.execution.id,
        caseId:scope.admission.receiptId,ownerId,type:"environment.operation",payload}));
    }:undefined,
    executeHarness:async(request,signal)=> {
      const scope=scopes.get(request.id),native=deps.nativeHarness;
      if(!scope||contentHash(scope.admission.request)!==contentHash(request)||native?.qualified!==true||!request.harness)
        throw new LocalExperimentError("local_native_owner_missing","Only the durable case owner may dispatch the admitted native Harness.",422);
      const owned=await native.execute({executionId:scope.execution.id,request,source:request.harness,
        stream:createLocalBudgetedModelStream({store:deps.store,ownerId,teamId:scope.execution.teamId,
          executionId:scope.execution.id,caseId:scope.admission.receiptId,admission:scope.model,stream:streamForActor(scope.execution.ownerActorId,scope.execution.teamId)}),
        signal,maxOutputBytes:262_144});
      const attempt=localRetainedAttempt(owned.attempt),evidence=attempt.native;
      if(attempt.taskId!==request.taskId||!evidence||evidence.admissionHash!==request.admissionHash
        ||evidence.modelConfigurationHash!==request.model.configurationHash||contentHash(evidence.source)!==contentHash(request.harness)
        ||evidence.sessionId!==owned.sessionId||evidence.turnId!==owned.turn.id||evidence.traceHash!==owned.traceHash
        ||contentHash(evidence.runtimeEventRefs)!==contentHash(owned.runtimeEventRefs))
        throw new LocalExperimentError("local_native_receipt_conflict","Native output or trace differs from the exact admitted case.");
      return owned.attempt;
    },
  });
  async function requireTeam(teamId:string) {
    if(await deps.teamId()!==teamId)throw new LocalExperimentError("local_workspace_denied","Select this workspace before accessing its local Experiments.",403);
  }
  async function requireActor(ownerActorId:string) {
    if(await deps.actorId()!==ownerActorId)throw new LocalExperimentError("local_resource_denied","This local resource is unavailable to the current account.",404);
  }
  function streamForActor(ownerActorId:string,teamId:string):typeof streamOpenPondHostedChatTurn {
    return async function*(request) {
      await requireActor(ownerActorId);await requireTeam(teamId);
      yield* (deps.stream??streamOpenPondHostedChatTurn)(request);
    };
  }
  async function ownedDefinition(teamId:string,id:string,revision?:number) {
    const value=await deps.store.readLocalExperiment(teamId,id,revision);await requireActor(value.definition.ownerActorId);
    if(projectScope.getStore()&&value.definition.configuration.request.project?.id!==projectScope.getStore())
      throw new LocalExperimentError("local_project_resource_denied","This Experiment does not belong to the selected Project.",404);
    return value;
  }
  async function ownedRecord(teamId:string,id:string):Promise<LocalExperimentRecord> {
    await requireTeam(teamId);
    const execution=await deps.store.readLocalExecution(teamId,id);await requireActor(execution.execution.ownerActorId);
    const record=await deps.store.readLocalExperimentRecord(teamId,id);
    if(projectScope.getStore()&&record.configuration.request.project?.id!==projectScope.getStore())
      throw new LocalExperimentError("local_project_resource_denied","This Experiment does not belong to the selected Project.",404);
    await requireActor(record.ownerActorId);await requireTeam(teamId);
    return record;
  }
  async function ownedExecution(teamId:string,id:string) {
    const value=await deps.store.readLocalExecution(teamId,id);await requireActor(value.execution.ownerActorId);
    const targetId=value.execution.kind==="target"?id:value.execution.sourceExecution!.id;
    await ownedRecord(teamId,targetId);
    return value;
  }
  const scoring=createLocalExperimentScoring({...deps,ownerId,requireTeam,requireActor,requireExecution:async(teamId,id)=>{await ownedExecution(teamId,id);},streamForActor,active,controllers});
  async function admitProfile(configuration:import("./local-experiment-contract.js").LocalExperimentDefinition["configuration"],value:TasksetPackage) {
    if(configuration.request.policy.kind!=="hosted_harness")return false;
    if(!deps.profile)throw new LocalExperimentError("local_profile_not_qualified","This local server has no qualified exact Profile owner.",422);
    await deps.profile.resolve(configuration,value);return true;
  }
  const admission=createLocalExperimentRunAdmission({store:deps.store,ownerId,catalog:deps.catalog,actorId:deps.actorId,
    requireActor,requireTeam,ownedRecord,closing:()=>closing,
    assertScope:configuration=>{if(projectScope.getStore()&&configuration.request.project?.id!==projectScope.getStore())
      throw new LocalExperimentError("local_project_resource_denied","This Experiment does not belong to the selected Project.",404);},
    authorize:async configuration=>{await deps.authorizeProject?.(configuration);},
    preflight:async(configuration,value)=>{
      const profile=await admitProfile(configuration,value),native=await admitLocalNativeHarness(configuration.request.policy,deps.nativeHarness);
      await deps.environment?.preflight(value);return {profile,native,environment:Boolean(deps.environment)};
    },
    package:async input=>{
      const {sourceExperimentId,...configuration}=input.configuration;void sourceExperimentId;
      const retained={...configuration,expectedRevision:0};
      if(retained.request.policy.kind==="hosted_harness"&&deps.profile)return deps.profile.package(retained);
      if(!deps.resolvePackage)throw new LocalExperimentError("local_release_transfer_unavailable","This server cannot read an exact retained Dataset release.",503);
      return deps.resolvePackage({configuration:retained,...(input.expectedPackageHash?{expectedPackageHash:input.expectedPackageHash}:{})});
    },
    schedule:(execution,admissions,model)=>{
      if(active.has(execution.id))return;
      const work=executeAdmissions(execution,admissions,model).finally(()=>{active.delete(execution.id);controllers.delete(execution.id);});
      active.set(execution.id,work);
    },
  });
  async function executeAdmissions(execution:LocalExperimentExecution,admissions:LocalExperimentAdmission[],model:LocalModelAdmission) {
    let error:string|null=null,cleanupComplete=true;
    const controller=new AbortController();controllers.set(execution.id,controller);
    const retained=await deps.store.readLocalExperiment(execution.teamId,execution.definition.id,execution.definition.revision);
    const packageValue=validateTasksetPackage(retained.package),definition=retained.definition;
    try {
      for(const admission of admissions) {
        if(closing)break;
        if(!await deps.store.admitLocalCase(execution.teamId,execution.id,admission.receiptId,ownerId))break;
        scopes.set(admission.request.id,{execution,admission,model});
        let attempt:unknown|null=null;
        try {
          controller.signal.throwIfAborted();
          const result=definition.configuration.request.policy.kind==="hosted_harness"&&deps.profile
            ?await deps.profile.execute({executionId:execution.id,admission,configuration:definition.configuration,package:packageValue,
              stream:createLocalBudgetedModelStream({store:deps.store,ownerId,teamId:execution.teamId,executionId:execution.id,
                caseId:admission.receiptId,admission:model,stream:streamForActor(execution.ownerActorId,execution.teamId)}),signal:controller.signal})
            :await cases.execute(admission.request);attempt=result;
          const outcome=localRetainedAttempt(result);
          if(definition.configuration.request.policy.kind==="hosted_harness") {
            const evidence=outcome.profileNative;
            if(!evidence||evidence.admissionHash!==admission.request.admissionHash
              ||evidence.modelConfigurationHash!==definition.model.configurationHash
              ||contentHash(evidence.source)!==contentHash(definition.configuration.request.policy.source))
              throw new LocalExperimentError("local_profile_receipt_conflict","Profile output or trace differs from the exact admitted case.");
          }
          const task=packageValue.taskset.tasks.find(task=>task.id===admission.taskId)!;
          const grade=await gradeLocalExperimentCase({store:deps.store,ownerId,teamId:execution.teamId,executionId:execution.id,caseId:admission.receiptId,
            package:packageValue,task,evidence:{output:{text:outcome.output??""},runtimeEventRefs:outcome.native?.runtimeEventRefs??outcome.profileNative?.runtimeEventRefs??[],artifactRefs:[],infrastructureError:outcome.status==="completed"?null:outcome.error??outcome.status},
            evaluatorContext:localEvaluatorContext(outcome),
            graders:definition.graders,signal:controller.signal,judgeProvider:createLearningHostedJudgeProvider({stream:streamForActor(execution.ownerActorId,execution.teamId),catalog:deps.catalog})});
          await deps.store.settleLocalCase({teamId:execution.teamId,id:execution.id,receiptId:admission.receiptId,ownerId,
            status:outcome.status==="completed"?"completed":outcome.status==="cancelled"?"cancelled":"failed",result:sealLocalRetainedCase(result,grade),error:outcome.error});
          if(outcome.status!=="completed")error=outcome.error??outcome.status;
        } catch(cause) {
          error=message(cause);
          let retained:unknown|null=null;
          if(attempt) {try{retained=sealLocalRetainedCase(attempt,null);}catch{cleanupComplete=false;}}
          else cleanupComplete=false;
          await deps.store.settleLocalCase({teamId:execution.teamId,id:execution.id,receiptId:admission.receiptId,ownerId,
            status:controller.signal.aborted?"cancelled":"failed",result:retained,error});
        } finally {scopes.delete(admission.request.id);}
        if(error)break;
      }
      if(closing)await deps.store.cancelLocalExecution(execution.teamId,execution.id);
      await deps.store.finishLocalExecution(execution.teamId,execution.id,ownerId,error,cleanupComplete);
    } catch(cause) {
      // Owner remains durable if settlement itself fails. Startup recovery
      // records unknown outcomes; it never retries this admitted target.
      error=message(cause);
      await deps.store.finishLocalExecution(execution.teamId,execution.id,ownerId,error,false).catch(()=>{});
    }
  }
  async function read(raw:unknown) {
    const input=LocalExperimentRecordReadSchema.parse(raw);await requireTeam(input.teamId);
    const record=await ownedRecord(input.teamId,input.id);
    if(input.configurationHash&&record.configurationHash!==input.configurationHash)
      throw new LocalExperimentError("local_configuration_pin_conflict","The retained Experiment differs from the requested configuration.");
    return record;
  }
  async function list(raw:unknown) {
    const input=LocalExperimentListSchema.parse(raw);
    await requireTeam(input.teamId);const actor=await deps.actorId(),page=await deps.store.listLocalExperimentRecords({...input,ownerActorId:actor});
    await requireTeam(input.teamId);await requireActor(actor);return page;
  }
  async function publicExecution(teamId:string,id:string) {const value=(await ownedExecution(teamId,id)).execution;
    if(value.kind==="target")return ownedRecord(teamId,id);const {definition,...receipt}=value;void definition;return receipt;}
  async function status(raw:unknown) {const input=LocalExperimentReadSchema.parse(raw);await requireTeam(input.teamId);return publicExecution(input.teamId,input.id);}
  async function cancel(raw:unknown) {
    const input=LocalExperimentReadSchema.parse(raw);await requireTeam(input.teamId);
    await ownedExecution(input.teamId,input.id);
    const result=await deps.store.cancelLocalExecution(input.teamId,input.id);
    controllers.get(input.id)?.abort(new Error("local_experiment_cancelled"));
    for(const scope of scopes.values())if(scope.execution.id===input.id&&scope.execution.teamId===input.teamId)cases.cancel(scope.admission.request.id);
    void result;return publicExecution(input.teamId,input.id);
  }
  async function result(raw:unknown) {
    const input=LocalExperimentReadSchema.parse(raw);await requireTeam(input.teamId);
    const value=await ownedExecution(input.teamId,input.id);
    const content={execution:await publicExecution(input.teamId,input.id),cases:value.cases.map(value=>({receiptId:value.receiptId,taskId:value.admission.taskId,seed:value.admission.seed,status:value.status,
      input:value.admission.request.input,policyVisibleContext:value.admission.request.policyVisibleContext,
      output:value.result?localRetainedCase(value.result).attempt.output:null,
      messages:value.result?localRetainedCase(value.result).attempt.messages:[],grade:value.result?localRetainedCase(value.result).grade:null,error:value.error,
      ...(value.result&&localRetainedCase(value.result).attempt.native?{native:localRetainedCase(value.result).attempt.native}:{}),
      ...(value.result&&localRetainedCase(value.result).attempt.profileNative?{profileNative:localRetainedCase(value.result).attempt.profileNative}:{})}))};
    return {...content,contentHash:contentHash(content)};
  }
  async function inspectCase(raw:unknown) {
    const input=z.object({teamId:z.string().min(1),id:z.string().min(1),receiptId:z.string().min(1),afterSequence:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(500).default(100)}).strict().parse(raw);
    const retained=await result({teamId:input.teamId,id:input.id}),member=retained.cases.find(row=>row.receiptId===input.receiptId);
    if(!member)throw new LocalExperimentError("local_case_not_found","The selected case does not belong to this execution.",404);
    const trace=await deps.store.localExperimentTrace({teamId:input.teamId,id:input.id,caseId:input.receiptId,afterSequence:input.afterSequence,limit:input.limit});
    return {location:"local" as const,execution:retained.execution,case:member,trace};
  }
  async function compare(raw:unknown) {
    const input=z.object({teamId:z.string().min(1),baselineId:z.string().min(1),candidateId:z.string().min(1)}).strict().parse(raw);
    await requireTeam(input.teamId);
    const source=async(id:string)=> {
      const retained=await ownedExecution(input.teamId,id);
      const definition=await ownedDefinition(input.teamId,retained.execution.definition.id,retained.execution.definition.revision);
      const graders=retained.execution.kind==="scoring"?(await deps.store.readLocalScoringSelection(input.teamId,id)).graders:definition.definition.graders;
      const charges=await deps.store.readLocalExecutionCharges(input.teamId,id);
      await requireTeam(input.teamId);await requireActor(retained.execution.ownerActorId);
      const snapshot=await ownedRecord(input.teamId,retained.execution.sourceExecution?.id??id);
      return localPortableExperiment({retained,definition:definition.definition,package:definition.package,graders,charges,retainedConfigurationHash:snapshot.retainedConfigurationHash});
    };
    const baselineRead=source(input.baselineId);
    const [baseline,candidate]=await Promise.all([baselineRead,input.candidateId===input.baselineId?baselineRead:source(input.candidateId)]);
    return {location:"local" as const,baseline,candidate};
  }
  const readFeedback=createFeedbackSummaryReader();
  async function feedbackSummary(raw:unknown) {
    const input=LocalExperimentReadSchema.parse(raw),record=await ownedRecord(input.teamId,input.id);
    if(!record.completedAt)throw new LocalExperimentError("local_result_unavailable","This Experiment has no complete retained result yet.",422);
    return readFeedback(contentHash({teamId:record.teamId,actorId:record.ownerActorId,id:record.id,executionHash:record.executionHash}),async()=> {
      const evidence=(await compare({teamId:input.teamId,baselineId:input.id,candidateId:input.id})).baseline;
      return experimentFeedbackSummary({experimentId:record.id,executionManifestHash:record.executionHash,total:record.configuration.request.population.length,graders:record.graders,evidence});
    });
  }
  async function request(raw:unknown) {
    const command=z.object({teamId:z.string().min(1).max(200),projectId:z.string().min(1).max(200).nullable().optional(),action:z.enum(["sourceDataset","sourceChoices","prepareHarness","run","runFromRelease","read","get","list","status","cancel","result","score","scoreRetained","passes","pass","compare","feedbackSummary","case"]),payload:z.unknown()}).strict().parse(raw);
    const actor=await deps.actorId();
    if(!actor.trim())throw new LocalExperimentError("local_account_required","Sign in before accessing local Experiments.",403);
    const reply=await projectScope.run(command.projectId??null,()=>handleCommand(command));
    await requireTeam(command.teamId);await requireActor(actor);return reply;
  }
  async function handleCommand(command:{teamId:string;projectId?:string|null;action:"sourceDataset"|"sourceChoices"|"prepareHarness"|"run"|"runFromRelease"|"read"|"get"|"list"|"status"|"cancel"|"result"|"score"|"scoreRetained"|"passes"|"pass"|"compare"|"feedbackSummary"|"case";payload:unknown}) {
    await requireTeam(command.teamId);
    const scoped=()=>({...z.record(z.string(),z.unknown()).parse(command.payload),teamId:command.teamId,...(command.projectId&&command.action==="list"?{projectId:command.projectId}:{})});
    if(command.action==="sourceDataset") {
      const actor=await deps.actorId();
      if(!deps.sourceDataset)throw new LocalExperimentError("local_source_catalog_unavailable","The local source catalog is unavailable.",503);
      const page=await deps.sourceDataset(command.payload,command.teamId);
      await requireTeam(command.teamId);await requireActor(actor);return page;
    }
    if(command.action==="sourceChoices") {
      const actor=await deps.actorId();
      const choices=LocalExperimentSourceChoicesSchema.parse(await deps.sourceChoices?.()??{location:"local",harnesses:[],profiles:[]});
      await requireTeam(command.teamId);await requireActor(actor);
      return choices;
    }
    if(command.action==="prepareHarness") {
      if(!deps.profile)throw new LocalExperimentError("local_profile_not_qualified","This local server has no qualified Profile owner.",422);
      return deps.profile.prepare(command.payload,command.teamId);
    }
    if(command.action==="scoreRetained") {
      if(closing)throw new LocalExperimentError("local_runtime_closing","The local execution owner is closing.",503);
      const input=LocalExperimentRetainedScoreSchema.parse(command.payload);
      const original=(await ownedExecution(command.teamId,input.execution.id)).execution;
      const retained=await ownedDefinition(command.teamId,original.definition.id,original.definition.revision);
      const score=await scoring.score({...input,graderPackage:retained.package},command.teamId);return publicExecution(command.teamId,score.id);
    }
    if(command.action==="run"||command.action==="runFromRelease") {
      const payload=z.object({configuration:z.object({request:z.object({teamId:z.string()}).passthrough()}).passthrough()}).passthrough().parse(command.payload);
      if(payload.configuration.request.teamId!==command.teamId)throw new LocalExperimentError("local_workspace_conflict","The configuration belongs to another workspace.",403);
      return admission[command.action](command.payload);
    }
    if(command.action==="score") {
      if(closing)throw new LocalExperimentError("local_runtime_closing","The local execution owner is closing.",503);
      const score=await scoring.score(command.payload,command.teamId);return publicExecution(command.teamId,score.id);
    }
    const methods={read,get:read,list,status,cancel,result,
      passes:async(input:unknown)=>{const page=await scoring.passes(input);return {...page,items:page.items.map(item=>{const {definition,...receipt}=item;void definition;return receipt;})};},
      pass:async(input:unknown)=>{const pass=await scoring.pass(input);const {definition,...execution}=pass.execution;void definition;return {...pass,execution};},compare,feedbackSummary,case:inspectCase};
    return methods[command.action](scoped());
  }
  return {run:admission.run,runFromRelease:admission.runFromRelease,read,list,status,cancel,result,inspectCase,compare,score:scoring.score,passes:scoring.passes,pass:scoring.pass,request,
    async recover(){
      await deps.store.claimLocalExperimentOwner(ownerId);
      const recovered=await deps.store.recoverLocalExperiments(ownerId);
      heartbeat=setInterval(()=>{void deps.store.renewLocalExperimentOwner(ownerId).catch(()=>{
        closing=true;for(const controller of controllers.values())controller.abort(new Error("local_runtime_lease_lost"));void cases.close();
      });},5000);heartbeat.unref();
      return recovered;
    },
    async close(){closing=true;for(const controller of controllers.values())controller.abort(new Error("local_runtime_closed"));await cases.close();await Promise.allSettled([...active.values()]);
      if(heartbeat)clearInterval(heartbeat);await deps.store.releaseLocalExperimentOwner(ownerId);},
    async wait(id:string){await active.get(id);},
  };
}
function message(error:unknown){return (error instanceof Error?error.message:"Local execution failed.").slice(0,2000);}
