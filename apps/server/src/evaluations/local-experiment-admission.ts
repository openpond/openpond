import { contentHash } from "@openpond/harness";
import { compileBoundGraders, feedbackKeyForReward } from "@openpond/evals/rewards";
import { taskBatchPackageMetadata, verifyLearningTextAsset } from "@openpond/evals/learning";
import { policyTaskView } from "@openpond/evals/tasksets";
import { canonicalDatasetGraderSelection } from "openpond-sdk/experiments";
import { validateTasksetPackage, tasksetPackageRewardBinding, resolveTasksetPackageExecution,
  resolveTasksetPackageInstructions, type TasksetPackage } from "openpond-sdk/taskset-packages";
import { LocalExperimentError, type LocalExperimentDefinition, type LocalExperimentAdmission } from "./local-experiment-contract.js";
import { ExperimentModelCaseSchema } from "./experiment-case-contract.js";

/** Package-local Reward closure is authoritative; no selected Profile or
 * unrelated mutable grader catalog participates in local admission. */
export function localPackageGraders(value:TasksetPackage):LocalExperimentDefinition["graders"] {
  const binding=tasksetPackageRewardBinding(value);
  const rewards=value.modelResources?.rewards??(value.learningResources?taskBatchPackageMetadata(value.taskset).rewards:[]);
  if(binding && contentHash(compileBoundGraders(binding,rewards))!==contentHash(value.taskset.graders))
    throw new LocalExperimentError("local_grader_closure_conflict","The retained Reward closure differs from the released Dataset graders.",422);
  return value.taskset.graders.map(grader=> {
    const source=binding?.sources.find(source=>source.graderId===grader.id);
    const reward=source&&rewards.find(reward=>reward.id===source.reward.id&&reward.revision===source.reward.revision&&reward.contentHash===source.reward.contentHash);
    return {id:grader.id,version:grader.version,contentHash:contentHash(grader),
      name:reward?.name??("config" in grader&&grader.config.operator==="final_answer_equals_expected"?"Answer accuracy":`${grader.kind.replaceAll("_"," ")} grader`),
      feedbackKey:reward?feedbackKeyForReward(reward):`grader_${contentHash(grader.id).slice(0,24)}`,
      release:reward?{id:reward.id,revision:reward.revision,contentHash:reward.contentHash}:null};
  });
}
export function selectLocalPackageGraders(value:TasksetPackage,selections:LocalExperimentDefinition["configuration"]["graders"]) {
  const available=localPackageGraders(value);
  const pins=selections?selections.map(selection=> {
    const pin=available.find(pin=>pin.id===selection.id&&pin.version===selection.version&&pin.contentHash===selection.contentHash);
    if(!pin)throw new LocalExperimentError("local_grader_pin_unavailable","Select an exact grader from the retained Dataset package.",422);
    return {...pin,mappings:selection.mappings};
  }):available;
  try{return canonicalDatasetGraderSelection(pins);}
  catch(error){throw new LocalExperimentError("experiment_grader_feedback_conflict",error instanceof Error?error.message:"Grader selection conflicts.",422);}
}
export function localExperimentAdmissions(definition:LocalExperimentDefinition,rawPackage:unknown,executionId:string,nativeHarnessAdmitted=false,localEnvironmentAdmitted=false,profileAdmitted=false):LocalExperimentAdmission[] {
  const value=validateTasksetPackage(rawPackage),request=definition.configuration.request;
  if(value.contentHash!==definition.packageHash || contentHash(request.taskset)!==contentHash({id:value.taskset.id,revision:value.taskset.revision,contentHash:value.taskset.contentHash}))
    throw new LocalExperimentError("local_dataset_pin_conflict","Local execution requires the exact retained Dataset package.",422);
  if(request.policy.kind!=="hosted_chat"&&!(request.policy.kind==="hosted_harness"&&profileAdmitted))throw new LocalExperimentError("local_target_not_qualified","This local execution path requires a qualified exact target owner.",422);
  if(definition.model.providerId==="claude-code"&&(executionForClaude(value)||value.taskset.environment.kind!=="text"||value.taskset.tools.length))throw new LocalExperimentError("claude_environment_not_admitted","The Claude process adapter requires a text Dataset with no environment tools. Additional tool owners require explicit admission.",422);
  const harness=request.policy.kind==="hosted_chat"?request.policy.harness:undefined;
  if(harness&&!nativeHarnessAdmitted)throw new LocalExperimentError("local_harness_not_qualified","A released Harness must execute through its native turn owner.",422);
  const execution=resolveTasksetPackageExecution(value);
  if(value.taskset.policy.connectedAppScopes.length)throw new LocalExperimentError("local_connected_scope_not_qualified","This Dataset requires connected scopes that have not been admitted for local execution.",422);
  for(const capability of value.taskset.capabilities.filter(capability=>capability.required)) {
    // Grading runs behind the local owner after target execution. Its private
    // closure never becomes a model/tool capability or policy-visible input.
    if(capability.id!=="private-verifier")throw new LocalExperimentError("local_capability_not_qualified","This Dataset requires capabilities not supplied by the local execution owner.",422);
    const scopes=capability.scopes.length?capability.scopes:value.taskset.policy.hiddenGraderRefs;
    if(scopes.some(scope=>!value.taskset.policy.hiddenGraderRefs.includes(scope)||
      !value.taskset.graders.some(grader=>grader.id===scope&&grader.privileged&&grader.kind!=="human"&&
        (grader.kind!=="custom_verifier"||grader.runtime!=="sandbox_process"))))
      throw new LocalExperimentError("local_capability_not_qualified","The required private grader scope has no supported exact local grader owner.",422);
  }
  if(!execution&&value.taskset.tools.length&&!profileAdmitted)throw new LocalExperimentError("local_tool_target_not_qualified","This Dataset's tools require a released native target executor.",422);
  if(execution?.execution.javascript.executionServices?.length&&!localEnvironmentAdmitted)throw new LocalExperimentError("local_prepared_environment_not_qualified","This Dataset requires prepared compute services that are not yet bound to the local execution owner.",422);
  if(value.taskset.environment.kind!=="text" && !execution)throw new LocalExperimentError("local_environment_unavailable","The released Dataset has no supported local environment executor.",422);
  if(harness&&(execution||value.taskset.environment.kind!=="text"))throw new LocalExperimentError("local_harness_environment_not_qualified","This native Harness requires a compatible text Dataset.",422);
  return request.population.map(member=> {
    const task=value.taskset.tasks.find(task=>task.id===member.taskId);
    if(!task)throw new LocalExperimentError("local_population_unavailable","The selected task is absent from this immutable Dataset release.",422);
    const policy=policyTaskView(task);
    if((policy.artifactRefs.length||task.requiredOutputs?.length)&&!(profileAdmitted&&request.policy.kind==="hosted_harness"))throw new LocalExperimentError("local_work_target_not_qualified","This Dataset requires document input or Work output capabilities not supplied by this local model target.",422);
    const module=execution?.assets.find(asset=>asset.id===execution.execution.javascript.module.id);
    const state=execution?.assets.find(asset=>asset.id===task.privilegedContextRef);
    if(execution&&(!module||!state))throw new LocalExperimentError("local_environment_assets_missing","Private environment resources are missing from the retained package.",422);
    const admitted={kind:"model" as const,id:`local-case-${contentHash([executionId,member.receiptId]).slice(0,48)}`,
      taskId:task.id,model:definition.model,...(harness?{harness}:{}),instructions:resolveTasksetPackageInstructions(value),
      input:policy.input,policyVisibleContext:policy.policyVisibleContext,timeoutMs:value.taskset.environment.defaultTimeoutMs,
      environment:execution?{kind:"javascript" as const,definition:execution.execution.javascript,asset:module!,
        initialState:JSON.parse(verifyLearningTextAsset(state!,state!.asset)) as Record<string,unknown>,seed:Number(member.seed)}:{kind:"text" as const}};
    return {receiptId:member.receiptId,taskId:member.taskId,seed:member.seed,
      request:ExperimentModelCaseSchema.parse({...admitted,admissionHash:contentHash(admitted)})};
  });
}

function executionForClaude(value:TasksetPackage){return Boolean(resolveTasksetPackageExecution(value));}
