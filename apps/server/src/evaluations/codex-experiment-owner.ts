import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {z} from "zod";
import {contentHash} from "@openpond/harness";
import type {CodexStatus} from "@openpond/contracts";
import {withCodexModelCatalog} from "../providers/codex-model-catalog.js";
import {createCodexTasksetPolicyRuntime,codexEvaluationAccountHash} from "../training/codex-taskset-policy-runtime.js";
import type {LocalInferenceState} from "./local-experiment-local-inference.js";
import type {LocalModelAdmission} from "./local-experiment-model.js";
import type {LocalExperimentDefinition} from "./local-experiment-contract.js";
import {LocalExperimentError} from "./local-experiment-contract.js";

const Completion=z.object({response:z.object({choices:z.array(z.object({message:z.object({content:z.string().nullable(),tool_calls:z.array(z.unknown())})})).length(1)}),usage:z.object({promptTokens:z.number().int().nonnegative(),completionTokens:z.number().int().nonnegative(),totalTokens:z.number().int().nonnegative()}).optional()});
function fail(message:string):never {throw new LocalExperimentError("codex_experiment_not_ready",message,422);}

/** Subscription owner reuses the existing native policy executor. Neither chat
 * history, repo files nor private grader inputs enter its ephemeral thread. */
export function createCodexExperimentOwner(deps:{state:LocalInferenceState;status?:()=>Promise<CodexStatus>;
  runtime?:typeof createCodexTasksetPolicyRuntime}) {
  async function resolve(modelId?:string) {
    if(!deps.status)fail("The signed-in Codex runtime is unavailable.");
    const status=await deps.status();
    const accountHash=codexEvaluationAccountHash(status.account);
    if(!status.available || status.authHealth!=="signed_in" || !accountHash || !status.version || !status.binaryPath)fail("Sign in to Codex with your ChatGPT account before evaluating.");
    const current=await deps.state();
    if(!current.settings.providers.codex?.enabled)fail("Enable Codex in Settings before evaluating.");
    const settings=await withCodexModelCatalog(current.settings,status);
    const models=settings.modelCaches.codex?.models.filter(model=>model.capabilities.reasoningEfforts?.includes("low")) ?? [];
    if(!modelId)return {status,accountHash,models};
    const model=models.find(model=>model.id===modelId);
    if(!model)fail("Refresh the installed Codex catalog and select a model supporting Lite reasoning.");
    const configurationHash=contentHash({providerId:"codex",modelId,accountHash,binaryPath:status.binaryPath,version:status.version,capabilities:model.capabilities,reasoningEffort:"low",isolation:"openpond.codex-text-evaluation.v1"});
    return {status,accountHash,models,model,configurationHash};
  }
  return {
    async readiness() {
      try {const current=await resolve();return {ready:true as const,choices:await Promise.all(current.models.map(async model=>{const selected=await resolve(model.id);return {id:model.id,name:model.displayName+" · Lite",providerId:"codex" as const,configurationHash:selected.configurationHash!,accountHash:selected.accountHash,reasoningEffort:"low" as const,outputLimit:4096};}))};}
      catch(error) {if(!(error instanceof LocalExperimentError))throw error;return {ready:false as const,reason:error.message,choices:[]};}
    },
    async prepare(configuration:LocalExperimentDefinition["configuration"]):Promise<LocalModelAdmission> {
      const policy=configuration.request.policy;
      if(policy.kind!=="hosted_chat" || policy.localRuntime?.providerId!=="codex")fail("Select an exact Codex experiment runtime.");
      const runtime=policy.localRuntime,selected=await resolve(policy.modelId);
      if(selected.configurationHash!==runtime.configurationHash || selected.accountHash!==runtime.accountHash || runtime.reasoningEffort!=="low")fail("Codex account, model or runtime changed. Review its current model pin.");
      if(policy.harness || policy.candidate || policy.temperature!==0 || policy.topP!==1 || policy.maxOutputTokens>4096 || runtime.maximumRequestCostUsd>configuration.maximumCostUsd)fail("Codex evaluation requires a model-only text target with default sampling and a supported output allowance.");
      const model={providerId:"codex" as const,modelId:policy.modelId,maxOutputTokens:policy.maxOutputTokens,messages:policy.messages??[],configurationHash:contentHash({modelId:policy.modelId,runtime,messages:policy.messages??[],maxOutputTokens:policy.maxOutputTokens})};
      return {model,pricing:null,maximumChargeUsd:runtime.maximumRequestCostUsd,streamFactory(scope){return async function*(request) {
        const latest=await resolve(model.modelId);
        if(latest.configurationHash!==runtime.configurationHash)fail("Codex account or runtime changed before dispatch.");
        if(request.tools?.length)fail("Codex text evaluations do not admit environment tools.");
        if(Buffer.byteLength(JSON.stringify(request.messages))>262144)fail("Codex evaluation input exceeds its retained text allowance.");
        const cwd=await mkdtemp(path.join(os.tmpdir(),"openpond-codex-eval-"));
        const executor=(deps.runtime ?? createCodexTasksetPolicyRuntime)({modelId:model.modelId,runId:scope.executionId,cwd,binaryPath:latest.status.binaryPath!,reasoningEffort:runtime.reasoningEffort,isolatedAccountHash:runtime.accountHash});
        const timeout=AbortSignal.timeout(runtime.requestTimeoutMs),signal=request.signal?AbortSignal.any([request.signal,timeout]):timeout;
        const abort=()=>{void executor.close().catch(()=>undefined);};signal.addEventListener("abort",abort,{once:true});
        try {
          signal.throwIfAborted();
          const result=Completion.parse(await executor.complete({messages:request.messages,tools:[],deliveryId:scope.caseId,turnIndex:request.requestId},signal));
          signal.throwIfAborted();
          const message=result.response.choices[0]!.message;
          if(message.tool_calls.length || message.content===null)fail("The Codex model did not return a text task answer.");
          if(Buffer.byteLength(message.content)>Math.min(262144,model.maxOutputTokens*4))fail("Codex output exceeds this run's retained output allowance.");
          yield {type:"text_delta",text:message.content,raw:{}};
          if(result.usage)yield {type:"usage",usage:{prompt_tokens:result.usage.promptTokens,completion_tokens:result.usage.completionTokens,total_tokens:result.usage.totalTokens},raw:{}};
          yield {type:"finish",finishReason:"stop",raw:{}};
        } finally {signal.removeEventListener("abort",abort);await executor.close();await rm(cwd,{recursive:true,force:true});}
      };}};
    },
  };
}
