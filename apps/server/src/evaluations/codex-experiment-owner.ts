import { NATIVE_OUTPUT_SCHEMA_ENCODING_VERSION } from "../providers/native-output-schema.js";
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
import {CodexExperimentRuntimeSchema, type CodexExperimentRuntime} from "openpond-sdk/experiments";

const MAX_INPUT_BYTES=1_048_576;
const Completion=z.object({response:z.object({choices:z.array(z.object({message:z.object({content:z.string().nullable(),tool_calls:z.array(z.object({id:z.string(),type:z.literal("function"),function:z.object({name:z.string(),arguments:z.string()})}))})})).length(1)}),usage:z.object({promptTokens:z.number().int().nonnegative(),completionTokens:z.number().int().nonnegative(),totalTokens:z.number().int().nonnegative()}).optional()});
function fail(message:string):never {throw new LocalExperimentError("codex_experiment_not_ready",message,422);}

/** Subscription owner reuses the existing native policy executor. Neither chat
 * history, repo files nor private grader inputs enter its ephemeral thread. */
export function createCodexExperimentOwner(deps:{state:LocalInferenceState;status?:()=>Promise<CodexStatus>;
  runtime?:typeof createCodexTasksetPolicyRuntime}) {
  async function resolve(modelId?:string,reasoningEffort:CodexExperimentRuntime["reasoningEffort"]="low") {
    if(!deps.status)fail("The signed-in Codex runtime is unavailable.");
    const status=await deps.status();
    const accountHash=codexEvaluationAccountHash(status.account);
    if(!status.available || status.authHealth!=="signed_in" || !accountHash || !status.version || !status.binaryPath)fail("Sign in to Codex with your ChatGPT account before evaluating.");
    const current=await deps.state();
    if(!current.settings.providers.codex?.enabled)fail("Enable Codex in Settings before evaluating.");
    const settings=await withCodexModelCatalog(current.settings,status);
    const models=settings.modelCaches.codex?.models.filter(model=>model.capabilities.reasoningEfforts?.some(effort=>CodexExperimentRuntimeSchema.shape.reasoningEffort.safeParse(effort).success)) ?? [];
    if(!modelId)return {status,accountHash,models};
    const model=models.find(model=>model.id===modelId);
    if(!model || !model.capabilities.reasoningEfforts?.includes(reasoningEffort))fail("Select a model and reasoning effort supported by the installed Codex catalog.");
    const configurationHash=contentHash({providerId:"codex",modelId,accountHash,binaryPath:status.binaryPath,version:status.version,capabilities:model.capabilities,reasoningEffort,outputLimit:16384,maximumInputBytes:MAX_INPUT_BYTES,structuredOutputEncoding:NATIVE_OUTPUT_SCHEMA_ENCODING_VERSION,isolation:"openpond.codex-text-evaluation.v2"});
    return {status,accountHash,models,model,configurationHash};
  }
  async function choice(modelId:string,reasoningEffort:CodexExperimentRuntime["reasoningEffort"]="low") {
    const selected=await resolve(modelId,reasoningEffort);
    return {id:modelId,name:selected.model!.displayName+", "+reasoningEffort,providerId:"codex" as const,configurationHash:selected.configurationHash!,accountHash:selected.accountHash,reasoningEffort,reasoningEfforts:selected.model!.capabilities.reasoningEfforts,outputLimit:16384};
  }
  return {
    choice,
    async readiness() {
      try {const current=await resolve();return {ready:true as const,choices:await Promise.all(current.models.map(model=>choice(model.id,model.capabilities.reasoningEfforts?.includes("low")?"low":CodexExperimentRuntimeSchema.shape.reasoningEffort.parse(model.capabilities.reasoningEfforts?.find(effort=>CodexExperimentRuntimeSchema.shape.reasoningEffort.safeParse(effort).success)))))};}
      catch(error) {if(!(error instanceof LocalExperimentError))throw error;return {ready:false as const,reason:error.message,choices:[]};}
    },
    async prepare(configuration:LocalExperimentDefinition["configuration"]):Promise<LocalModelAdmission> {
      const policy=configuration.request.policy;
      if(!["hosted_chat","hosted_harness"].includes(policy.kind) || !("localRuntime" in policy) || policy.localRuntime?.providerId!=="codex")fail("Select an exact Codex experiment runtime.");
      if(policy.kind!=="hosted_chat" && policy.kind!=="hosted_harness")fail("Select a supported Codex target.");
      const profile = policy.kind === "hosted_harness";
      const runtime=policy.localRuntime,selected=await resolve(policy.modelId,runtime.reasoningEffort);
      if(selected.configurationHash!==runtime.configurationHash || selected.accountHash!==runtime.accountHash)fail("Codex account, model or runtime changed. Review its current model pin.");
      if(policy.candidate || policy.kind === "hosted_chat" && (policy.harness || policy.temperature!==0 || policy.topP!==1 || policy.maxOutputTokens>16384) || runtime.maximumRequestCostUsd>configuration.maximumCostUsd)fail("Codex evaluation requires its qualified text or Profile owner and a supported request allocation.");
      const maxOutputTokens=policy.kind === "hosted_chat" ? policy.maxOutputTokens : 16384;
      const messages=policy.kind === "hosted_chat" ? policy.messages??[] : [];
      const model={providerId:"codex" as const,modelId:policy.modelId,maxOutputTokens,messages,configurationHash:contentHash({modelId:policy.modelId,runtime,messages,maxOutputTokens})};
      return {model,pricing:null,maximumChargeUsd:runtime.maximumRequestCostUsd,streamFactory(scope){return async function*(request) {
        const latest=await resolve(model.modelId,runtime.reasoningEffort);
        if(latest.configurationHash!==runtime.configurationHash)fail("Codex account or runtime changed before dispatch.");
        if(!profile && request.tools?.length)fail("Codex text evaluations do not admit environment tools.");
        const inputBytes=Buffer.byteLength(JSON.stringify(request.messages));
        if(inputBytes>MAX_INPUT_BYTES)fail("Codex evaluation input exceeds its 1 MiB retained text allowance.");
        await scope.store.appendLocalExperimentEvent({...scope,id:scope.executionId,type:"codex.input_admitted",payload:{modelId:model.modelId,inputBytes,maximumInputBytes:MAX_INPUT_BYTES,configurationHash:runtime.configurationHash}});
        const cwd=await mkdtemp(path.join(os.tmpdir(),"openpond-codex-eval-"));
        const executor=(deps.runtime ?? createCodexTasksetPolicyRuntime)({modelId:model.modelId,runId:scope.executionId,cwd,binaryPath:latest.status.binaryPath!,reasoningEffort:runtime.reasoningEffort,isolatedAccountHash:runtime.accountHash,outputSchema:runtime.outputSchema});
        const timeout=AbortSignal.timeout(runtime.requestTimeoutMs),signal=request.signal?AbortSignal.any([request.signal,timeout]):timeout;
        const abort=()=>{void executor.close().catch(()=>undefined);};signal.addEventListener("abort",abort,{once:true});
        try {
          signal.throwIfAborted();
          const result=Completion.parse(await executor.complete({messages:request.messages,tools:profile ? request.tools??[] : [],deliveryId:scope.caseId,turnIndex:request.requestId},signal));
          signal.throwIfAborted();
          const message=result.response.choices[0]!.message;
          if(!profile && message.tool_calls.length || !message.tool_calls.length && message.content===null)fail("The Codex model did not return an admitted task response.");
          if(message.content!==null && Buffer.byteLength(message.content)>Math.min(262144,model.maxOutputTokens*4))fail("Codex output exceeds this run's retained output allowance.");
          if(message.content!==null)yield {type:"text_delta",text:message.content,raw:{}};
          if(message.tool_calls.length)yield {type:"tool_call_delta",toolCalls:message.tool_calls,raw:{}};
          if(result.usage)yield {type:"usage",usage:{prompt_tokens:result.usage.promptTokens,completion_tokens:result.usage.completionTokens,total_tokens:result.usage.totalTokens},raw:{}};
          yield {type:"finish",finishReason:message.tool_calls.length ? "tool_calls" : "stop",raw:{}};
        } finally {signal.removeEventListener("abort",abort);await executor.close();await rm(cwd,{recursive:true,force:true});}
      };}};
    },
  };
}
