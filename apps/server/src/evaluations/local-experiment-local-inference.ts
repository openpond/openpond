import {contentHash} from "@openpond/harness";
import type {ProviderSettings} from "@openpond/contracts";
import type {HostedChatUsage} from "@openpond/cloud";
import type {ProviderSecrets} from "../openpond/provider-secrets.js";
import {resolveOpenAiCompatibleProvider,streamOpenAiCompatibleChatCompletion} from "../openpond/openai-compatible-provider.js";
import type {LocalExperimentDefinition} from "./local-experiment-contract.js";
import {LocalExperimentError} from "./local-experiment-contract.js";
import type {LocalModelAdmission} from "./local-experiment-model.js";
export type LocalInferenceState=()=>Promise<{settings:ProviderSettings;secrets:ProviderSecrets}>;
function fail(message:string):never {throw new LocalExperimentError("local_inference_not_qualified",message,422);}
/** Existing provider registry and secret owner remain authoritative. Only an
 * explicitly selected loopback endpoint is admitted, with no hosted fallback. */
export function createLocalInferenceOwner(state:LocalInferenceState){
  async function resolve(modelId:string){const current=await state(),config=current.settings.providers["custom-openai-compatible"],model=current.settings.modelCaches["custom-openai-compatible"]?.models.find(m=>m.id===modelId);
    if(!config?.enabled||!model)fail("Enable the local OpenAI-compatible provider and refresh its model catalog.");
    let provider;
    try {provider=resolveOpenAiCompatibleProvider({providerId:"custom-openai-compatible",settings:current.settings,secrets:current.secrets,modelId});}
    catch(error) {fail(error instanceof Error ? error.message : "The local provider configuration is incomplete.");}
    const url=new URL(provider.baseUrl);
    if(!["localhost","127.0.0.1","[::1]","::1"].includes(url.hostname))fail("This local inference adapter requires an explicit loopback endpoint.");
    if(!model!.contextWindow||!model!.outputLimit||!model!.capabilities.streaming)fail("The current local model catalog must report context/output bounds and streaming support.");
    const closure={providerId:provider.providerId,modelId,endpointHash:contentHash(provider.baseUrl),contextWindow:model!.contextWindow,outputLimit:model!.outputLimit,capabilities:model!.capabilities};return{current,model:model!,configurationHash:contentHash(closure)};
  }
  return{
    async choices(){const current=await state(),models=current.settings.modelCaches["custom-openai-compatible"]?.models??[],choices=[];for(const model of models){try{const value=await resolve(model.id);choices.push({id:model.id,name:model.displayName,providerId:"custom-openai-compatible" as const,configurationHash:value.configurationHash,contextWindow:model.contextWindow,outputLimit:model.outputLimit});}catch(error){if(!(error instanceof LocalExperimentError))throw error;}}return choices;},
    async prepare(configuration:LocalExperimentDefinition["configuration"]):Promise<LocalModelAdmission>{const policy=configuration.request.policy;if(policy.kind!=="hosted_chat"||policy.localRuntime?.providerId!=="custom-openai-compatible")fail("Select an explicit local inference runtime.");const selected=await resolve(policy.modelId),runtime=policy.localRuntime!;
      if(selected.configurationHash!==runtime.configurationHash)fail("The local provider configuration changed. Review its current model before starting.");
      if(policy.harness||policy.candidate)fail("This model-only local inference adapter does not admit a native Harness or candidate runtime.");
      if(policy.maxOutputTokens>selected.model.outputLimit!||runtime.maximumRequestCostUsd>configuration.maximumCostUsd)fail("The selected output/request allocation exceeds this run's limits.");
      const rawCapabilities=selected.model.raw?.capabilities as {samplingParameters?:boolean}|undefined,sampling=rawCapabilities?.samplingParameters===true;if(!sampling&&(policy.temperature!==0||policy.topP!==1))fail("This local model has not declared configurable sampling.");
      const model={providerId:"custom-openai-compatible" as const,modelId:policy.modelId,maxOutputTokens:policy.maxOutputTokens,...(sampling?{temperature:policy.temperature,topP:policy.topP}:{}),messages:policy.messages??[]};
      return{model:{...model,configurationHash:contentHash({model,runtime})},pricing:null,maximumChargeUsd:runtime.maximumRequestCostUsd,stream:async function*(request){const latest=await resolve(model.modelId);if(latest.configurationHash!==runtime.configurationHash)fail("The local provider changed before dispatch.");if(request.tools?.length&&!latest.model.capabilities.toolCalling)fail("This local model has not declared tool calling.");const requestBytes=new TextEncoder().encode(JSON.stringify(request.messages)).byteLength;if(requestBytes>Math.min(2097152,latest.model.contextWindow!*2))fail("Policy-visible messages exceed this local model's bounded input allowance.");
        for await(const delta of streamOpenAiCompatibleChatCompletion({providerId:"custom-openai-compatible",settings:latest.current.settings,secrets:latest.current.secrets,modelId:model.modelId,messages:request.messages,tools:request.tools,requestId:request.requestId,maxOutputTokens:request.maxTokens,temperature:request.temperature,topP:request.topP,signal:request.signal,requestTimeoutMs:runtime.requestTimeoutMs})){if(delta.type==="usage")yield{type:"usage",usage:delta.usage as HostedChatUsage,raw:delta.raw};else if(delta.type!=="reasoning_delta")yield delta;}
      }};
    },
  };
}
