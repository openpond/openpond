import { contentHash } from "@openpond/harness";
import { loadOpenPondHostedModels, streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { HostedChatUsage } from "@openpond/cloud";
import type { LocalExperimentDefinition } from "./local-experiment-contract.js";
import { LocalExperimentError } from "./local-experiment-contract.js";
import { hostedTokenPricingFromCatalog, hostedUsageCostUsd, type HostedTokenPricing } from "../training/hosted-token-pricing.js";
import { normalizeModelUsageTokens } from "../runtime/model-usage-normalization.js";
import type { SqliteLocalExperimentStore } from "../store/store-local-experiments.js";

export type LocalModelAdmission={model:LocalExperimentDefinition["model"];pricing:HostedTokenPricing;maximumChargeUsd:number};
export async function prepareLocalExperimentModel(policy:LocalExperimentDefinition["configuration"]["request"]["policy"],catalog=loadOpenPondHostedModels,nativeHarnessAdmitted=false):Promise<LocalModelAdmission> {
  if(policy.kind==="hosted_harness")return prepareLocalExperimentModel({kind:"hosted_chat",modelId:policy.modelId,maxOutputTokens:4096,temperature:0,topP:1},catalog);
  if(policy.kind!=="hosted_chat")throw new LocalExperimentError("local_target_not_qualified","Select an explicit model target for local execution.",422);
  if(policy.harness&&!nativeHarnessAdmitted)throw new LocalExperimentError("local_harness_not_qualified","This released Harness requires its native turn executor; it cannot run as a model-only case.",422);
  const reply=await catalog();
  if(reply.error)throw new LocalExperimentError("local_model_catalog_unavailable",reply.error,422);
  const selected=reply.models.find(model=>model.id===policy.modelId);
  if(!selected)throw new LocalExperimentError("local_model_unavailable","The selected model is unavailable.",422);
  const raw=record(selected.raw),pricing=hostedTokenPricingFromCatalog(raw);
  const supportsSampling=record(raw.capabilities).samplingParameters===true;
  if(!supportsSampling&&(policy.temperature!==0||policy.topP!==1))throw new LocalExperimentError("local_sampling_unsupported","This model uses provider-managed sampling. Custom temperature or top P requires an explicit supported capability.",422);
  const contextWindow=positive(raw.context_window),outputLimit=positive(raw.output_limit);
  if(policy.maxOutputTokens>outputLimit)throw new LocalExperimentError("local_model_output_limit","The model cannot accept the configured output limit.",422);
  const configuration={providerId:"openpond" as const,modelId:policy.modelId,maxOutputTokens:policy.maxOutputTokens,
    ...(supportsSampling?{temperature:policy.temperature,topP:policy.topP}:{}),messages:policy.messages??[]};
  const maximumChargeUsd=(contextWindow*Math.max(pricing.inputUsdPerMillionTokens,pricing.cachedInputUsdPerMillionTokens)+policy.maxOutputTokens*pricing.outputUsdPerMillionTokens)/1_000_000;
  if(!(maximumChargeUsd>0))throw new LocalExperimentError("local_model_charge_unknown","The model must publish an enforceable positive request ceiling.",422);
  return {model:{...configuration,configurationHash:contentHash({configuration,contextWindow,outputLimit,pricing})},pricing,maximumChargeUsd};
}

/** Preserve normal provider transport. This wrapper owns only durable admission
 * and measured-or-unknown accounting; it never retries a dispatch. */
export function createLocalBudgetedModelStream(input:{store:SqliteLocalExperimentStore;ownerId:string;teamId:string;executionId:string;caseId:string;
  admission:LocalModelAdmission;stream?:typeof streamOpenPondHostedChatTurn}):typeof streamOpenPondHostedChatTurn {
  const stream=input.stream??streamOpenPondHostedChatTurn;
  return async function* (request) {
    if(!request.requestId)throw new LocalExperimentError("local_request_identity_missing","Every local model dispatch requires a stable request identity.");
    const model=input.admission.model;
    if(request.model!==model.modelId || request.maxTokens!==model.maxOutputTokens
      || request.temperature!==model.temperature || request.topP!==model.topP)
      throw new LocalExperimentError("local_model_configuration_conflict","The native model request changed its admitted model, output limit or sampling configuration.",422);
    const base={teamId:input.teamId,id:input.executionId,ownerId:input.ownerId,requestId:request.requestId};
    await input.store.reserveLocalCharge({...base,caseId:input.caseId,maximumUsd:input.admission.maximumChargeUsd});
    if(request.signal?.aborted) {
      await input.store.settleLocalCharge({...base,costUsd:null,usage:null,notDispatched:true});
      request.signal.throwIfAborted();
    }
    await input.store.markLocalChargeDispatched(base.teamId,base.id,base.requestId,base.ownerId);
    await input.store.appendLocalExperimentEvent({...base,caseId:input.caseId,type:"model.dispatch",payload:{requestId:base.requestId,model:request.model,messages:request.messages}});
    let usage:HostedChatUsage|null=null,finished=false;
    try {
      for await(const delta of stream(request)) {
        if(delta.type==="usage")usage=delta.usage;
        if(delta.type==="finish")finished=true;
        const payload=delta.type==="text_delta"?{requestId:base.requestId,text:delta.text}
          :delta.type==="tool_call_delta"?{requestId:base.requestId,toolCalls:delta.toolCalls}
          :delta.type==="usage"?{requestId:base.requestId,usage:normalizeModelUsageTokens(delta.usage)}
          :delta.type==="finish"?{requestId:base.requestId,finishReason:delta.finishReason}:null;
        if(payload)await input.store.appendLocalExperimentEvent({...base,caseId:input.caseId,type:`model.${delta.type}`,payload});
        yield delta;
      }
    } finally {
      const tokens=normalizeModelUsageTokens(usage);
      const costUsd=finished&&tokens.promptTokens!==null&&tokens.completionTokens!==null?hostedUsageCostUsd(usage,input.admission.pricing):null;
      await input.store.settleLocalCharge({...base,costUsd,usage:usage===null?null:{promptTokens:tokens.promptTokens,completionTokens:tokens.completionTokens,
        cachedPromptTokens:tokens.cachedPromptTokens,uncachedPromptTokens:tokens.uncachedPromptTokens}});
    }
  };
}
function record(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function positive(value:unknown){if(typeof value!=="number"||!Number.isSafeInteger(value)||value<=0)throw new LocalExperimentError("local_model_bound_unknown","The model catalog is missing an enforceable context/output bound.",422);return value;}
