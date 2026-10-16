import type { HostedChatMessage, HostedChatTool, HostedChatToolChoice } from "@openpond/cloud";
import { ProviderModelSchema, type ProviderSettings } from "@openpond/contracts";
import type { ProviderSecrets } from "./provider-secrets.js";
import { createProviderRequestSignal, parseSse, readProviderError, readLimitedResponseText, type OpenAiCompatibleStreamDelta } from "./openai-compatible-provider.js";

// The Messages API carries tool results as user blocks. Keep provider-specific
// continuation out of canonical history so a provider switch reprojects originals.
function messagesBody(messages: HostedChatMessage[]) {
  const system = messages.filter(message => message.role === "system").map(message => message.content ?? "").join("\n\n");
  const projected: {role: "user" | "assistant"; content: Record<string, unknown>[]}[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content: Record<string, unknown>[] = [];
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("Anthropic tool result is missing its call ID.");
      content.push({type:"tool_result",tool_use_id:message.tool_call_id,content:message.content ?? ""});
    } else {
      if (message.content) content.push({type:"text",text:message.content});
      for (const image of message.images ?? []) {
        const data = /^data:([^;,]+);base64,(.+)$/s.exec(image.url);
        content.push({type:"image",source:data ? {type:"base64",media_type:data[1],data:data[2]} : {type:"url",url:image.url}});
      }
      for (const call of message.tool_calls ?? []) {
        if (!call.id || !call.function?.name) throw new Error("Anthropic tool call is missing its ID or name.");
        content.push({type:"tool_use",id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments || "{}")});
      }
    }
    if (!content.length) continue;
    const previous=projected.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else projected.push({role,content});
  }
  return {system,messages:projected};
}

function anthropicConnection(input: {settings:ProviderSettings;secrets:ProviderSecrets;baseUrl?:string|null}) {
  const config=input.settings.providers.anthropic;
  const secret=input.secrets.providers.anthropic;
  // Native Claude Code credentials and OpenAI subscription credentials are never
  // borrowed here: direct Anthropic explicitly uses its configured API key.
  const key=secret?.source === "local_secret" ? secret.value?.trim() : secret?.source === "env" && secret.envVar ? process.env[secret.envVar]?.trim() : null;
  if (!config?.enabled || !key) throw new Error("Connect the direct Anthropic API-key provider in Settings.");
  const base=new URL(input.baseUrl ?? config.baseUrl ?? "https://api.anthropic.com");
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") throw new Error("Anthropic requires an HTTPS endpoint.");
  base.pathname=base.pathname.replace(/\/$/,"").replace(/\/v1$/,"")+"/v1";
  base.search="";base.hash="";
  return {key,base};
}

export async function* streamAnthropicChatCompletion(input: {
  settings: ProviderSettings; secrets: ProviderSecrets; modelId?: string | null;
  messages: HostedChatMessage[]; tools?: HostedChatTool[]; toolChoice?: HostedChatToolChoice;
  maxOutputTokens?: number; signal?: AbortSignal; requestTimeoutMs?: number;
}): AsyncGenerator<OpenAiCompatibleStreamDelta,void,unknown> {
  const {key,base}=anthropicConnection(input);
  base.pathname+="/messages";
  const model=input.modelId ?? input.settings.providers.anthropic?.defaultModel;
  if (!model) throw new Error("Choose a configured Anthropic model.");
  const catalogModel=input.settings.modelCaches.anthropic?.models.find(candidate=>candidate.id===model);
  const maxTokens=Math.max(1,Math.min(input.maxOutputTokens ?? 8192,catalogModel?.outputLimit ?? 8192));
  const tools=input.tools?.map(tool=>{
    if (tool.type !== "function" || !tool.function) throw new Error("Anthropic only supports function tools.");
    return {name:tool.function.name,description:tool.function.description,input_schema:tool.function.parameters ?? {type:"object",properties:{}}};
  });
  const choice=input.toolChoice;
  const toolChoice=choice === "required" ? {type:"any"} : choice === "auto" || choice === "none" ? {type:choice} : choice ? {type:"tool",name:choice.function.name} : undefined;
  const request=createProviderRequestSignal(input.signal,input.requestTimeoutMs);
  try {
    const response=await fetch(base,{method:"POST",redirect:"error",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","Content-Type":"application/json",Accept:"text/event-stream"},
      body:JSON.stringify({model,max_tokens:maxTokens,stream:true,...messagesBody(input.messages),...(tools?.length ? {tools,tool_choice:toolChoice} : {})}),signal:request.signal});
    if (!response.ok || !response.body) {
      const detail=await readProviderError(response,undefined,request.signal,request.touch);
      throw new Error(`Provider anthropic stream failed: ${response.status} ${detail.replaceAll(key,"[redacted]")}`);
    }
    const calls=new Map<number,{id:string;name:string;arguments:string;initial:unknown}>();
    let usage:Record<string,unknown>={};
    let finishReason:string|undefined;
    let stopped=false;
    for await (const raw of parseSse(response.body,request.signal,request.touch)) {
      if (!raw || typeof raw !== "object") continue;
      const event=raw as {type?:string;index?:number;error?:{message?:string};message?:{usage?:Record<string,unknown>};usage?:Record<string,unknown>;content_block?:{type?:string;id?:string;name?:string;input?:unknown;text?:string};delta?:{type?:string;text?:string;thinking?:string;partial_json?:string;stop_reason?:string}};
      if(event.type === "error") throw new Error(`Provider anthropic stream failed: ${(event.error?.message ?? "stream error").replaceAll(key,"[redacted]")}`);
      if(event.type === "message_start") usage={...event.message?.usage};
      if(event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const block=event.content_block;
        if(!block.id || !block.name || event.index === undefined) throw new Error("Invalid Anthropic tool block.");
        calls.set(event.index,{id:block.id,name:block.name,arguments:"",initial:block.input});
      }
      if(event.type === "content_block_delta") {
        if(event.delta?.type === "text_delta") yield {type:"text_delta",text:event.delta.text ?? "",raw};
        if(event.delta?.type === "thinking_delta") yield {type:"reasoning_delta",text:event.delta.thinking ?? "",raw};
        if(event.delta?.type === "input_json_delta" && event.index !== undefined) {
          const call=calls.get(event.index);
          if(!call) throw new Error("Anthropic tool delta has no matching call.");
          call.arguments+=event.delta.partial_json ?? "";
        }
      }
      if(event.type === "content_block_stop" && event.index !== undefined) {
        const call=calls.get(event.index);
        if(call) {
          const argumentsText=call.arguments || JSON.stringify(call.initial ?? {});
          JSON.parse(argumentsText);
          yield {type:"tool_call_delta",toolCalls:[{id:call.id,type:"function",function:{name:call.name,arguments:argumentsText}}],raw};
          calls.delete(event.index);
        }
      }
      if(event.type === "message_delta") {usage={...usage,...event.usage};finishReason=event.delta?.stop_reason;}
      if(event.type === "message_stop") {stopped=true;yield {type:"usage",usage,raw};}
    }
    if(!stopped || calls.size || !finishReason) throw new Error("Anthropic stream ended before the message completed.");
    yield {type:"finish",finishReason:finishReason === "tool_use" ? "tool_calls" : finishReason === "max_tokens" ? "length" : "stop",raw:{stop_reason:finishReason}};
  } finally {request.cleanup();}
}


export async function listAnthropicProviderModels(input: {settings:ProviderSettings;secrets:ProviderSecrets;baseUrl?:string|null;signal?:AbortSignal}) {
  const {key,base}=anthropicConnection(input);
  base.pathname+="/models";
  base.searchParams.set("limit","1000");
  const request=createProviderRequestSignal(input.signal);
  const models: ReturnType<typeof ProviderModelSchema.parse>[]=[];
  const seen=new Set<string>();
  try {
    for(let page=0;page<20;page++) {
      const response=await fetch(base,{redirect:"error",headers:{"x-api-key":key,"anthropic-version":"2023-06-01",Accept:"application/json"},signal:request.signal});
      if(!response.ok) throw new Error(`Anthropic model discovery failed: ${response.status} ${(await readProviderError(response,undefined,request.signal,request.touch)).replaceAll(key,"[redacted]")}`);
      const {text}=await readLimitedResponseText(response,5*1024*1024,{truncate:false},request.signal,request.touch);
      const payload=JSON.parse(text) as {data?:{id?:string;display_name?:string;max_input_tokens?:number|null;max_tokens?:number|null}[];has_more?:boolean;last_id?:string};
      if(!Array.isArray(payload.data)) throw new Error("Invalid Anthropic model catalog.");
      for(const model of payload.data) {
        if(!model.id || seen.has(model.id)) continue;
        seen.add(model.id);
        const known=input.settings.modelCaches.anthropic?.models.find(candidate=>candidate.id===model.id);
        models.push(ProviderModelSchema.parse({...known,id:model.id,displayName:model.display_name ?? model.id,providerId:"anthropic",source:"provider",contextWindow:model.max_input_tokens ?? known?.contextWindow,outputLimit:model.max_tokens ?? known?.outputLimit,capabilities:{...known?.capabilities,toolCalling:true,vision:true}}));
      }
      if(!payload.has_more) return models;
      const cursor=payload.last_id;
      if(!cursor || base.searchParams.get("after_id")===cursor) throw new Error("Anthropic model catalog did not advance.");
      base.searchParams.set("after_id",cursor);
    }
    throw new Error("Anthropic model catalog exceeded the page limit.");
  } finally {request.cleanup();}
}

export async function validateAnthropicProvider(input: {settings:ProviderSettings;secrets:ProviderSecrets;baseUrl?:string|null;modelId?:string|null}) {
  const {base}=anthropicConnection(input);
  const modelId=input.modelId ?? input.settings.providers.anthropic?.defaultModel ?? "";
  const models=await listAnthropicProviderModels(input);
  const modelFound=models.some(model=>model.id===modelId);
  const errors=modelFound ? [] : [`Model ${modelId} was not returned by Anthropic model discovery.`];
  return {providerId:"anthropic" as const,ok:!errors.length,live:true as const,baseUrl:base.toString(),modelId,modelFound,modelCount:models.length,errors};
}
