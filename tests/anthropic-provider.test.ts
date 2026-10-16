import {afterEach,expect,test,vi} from "vitest";
import {ProviderSettingsSchema} from "@openpond/contracts";
import {streamManagedLocalChatCompletion} from "../apps/server/src/openpond/managed-chat-provider";
import {listAnthropicProviderModels,validateAnthropicProvider} from "../apps/server/src/openpond/anthropic-provider";
import {createContextUsageSnapshot} from "../apps/server/src/openpond/context-usage";
import {normalizeModelUsageTokens} from "../apps/server/src/runtime/model-usage-normalization";
import type {ProviderSecrets} from "../apps/server/src/openpond/provider-secrets";

afterEach(()=>vi.unstubAllGlobals());
const settings=ProviderSettingsSchema.parse({providers:{anthropic:{enabled:true,baseUrl:"https://api.anthropic.com",defaultModel:"configured-claude"}},modelCaches:{anthropic:{providerId:"anthropic",models:[{id:"configured-claude",displayName:"Claude",providerId:"anthropic",source:"manual",outputLimit:4096}]}}});
const secrets:ProviderSecrets={version:1,providers:{anthropic:{source:"local_secret",value:"direct-key",envVar:null,oauth:null,createdAt:"",updatedAt:"",lastValidatedAt:null,lastError:null}}};
const sse=(events:unknown[])=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"Content-Type":"text/event-stream"}});

// A direct Claude coordinator must complete real wire tool calls/results without
// borrowing a native login, losing parallel call IDs, or undercounting cache use.
test("runs a direct Messages tool cycle and final answer with canonical provider-neutral history",async()=>{
  const requests:Record<string,unknown>[]=[];
  vi.stubGlobal("fetch",vi.fn(async(url:URL,init:RequestInit)=>{
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({"x-api-key":"direct-key","anthropic-version":"2023-06-01"});
    requests.push(JSON.parse(String(init.body)));
    return requests.length === 1 ? sse([
      {type:"message_start",message:{usage:{input_tokens:100,cache_read_input_tokens:30,cache_creation_input_tokens:20,output_tokens:1}}},
      {type:"content_block_start",index:0,content_block:{type:"tool_use",id:"call-a",name:"inspect",input:{}}},
      {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"id":'}},
      {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'"worker"}'}},
      {type:"content_block_stop",index:0},
      {type:"content_block_start",index:1,content_block:{type:"tool_use",id:"call-b",name:"list",input:{}}},
      {type:"content_block_stop",index:1},
      {type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:19}},
      {type:"message_stop"},
    ]) : sse([
      {type:"message_start",message:{usage:{input_tokens:130,output_tokens:1}}},
      {type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Worker complete"}},
      {type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:4}},
      {type:"message_stop"},
    ]);
  }));
  const input={providerId:"anthropic" as const,settings,secrets,messages:[{role:"system" as const,content:"Coordinate"},{role:"user" as const,content:"Inspect"}],tools:[{type:"function",function:{name:"inspect",parameters:{type:"object"}}}],maxOutputTokens:10000};
  const first=await Array.fromAsync(streamManagedLocalChatCompletion(input));
  const calls=first.flatMap(delta=>delta.type === "tool_call_delta" ? delta.toolCalls : []);
  expect(calls).toEqual([{id:"call-a",type:"function",function:{name:"inspect",arguments:'{"id":"worker"}'}},{id:"call-b",type:"function",function:{name:"list",arguments:"{}"}}]);
  expect(first.at(-1)).toMatchObject({type:"finish",finishReason:"tool_calls"});
  const usage=first.find(delta=>delta.type === "usage");
  expect(createContextUsageSnapshot({provider:"anthropic",model:"configured-claude",maxContextTokens:200000,messages:[],includeCompletion:true,updatedAtEventId:null,usage:usage?.type === "usage" ? usage.usage : null})).toMatchObject({usedTokens:169});
  expect(normalizeModelUsageTokens(usage?.type === "usage" ? usage.usage : null)).toMatchObject({promptTokens:150,completionTokens:19,cachedPromptTokens:30,cacheWritePromptTokens:20});
  const final=await Array.fromAsync(streamManagedLocalChatCompletion({...input,messages:[...input.messages,{role:"assistant",content:null,tool_calls:calls,continuation:{kind:"responses_reasoning_items",items:[{id:"foreign-provider-continuation"}]}},{role:"tool",tool_call_id:"call-a",content:"complete"},{role:"tool",tool_call_id:"call-b",content:"worker"}]}));
  expect(requests[1]).toMatchObject({max_tokens:4096,messages:[{role:"user",content:[{type:"text",text:"Inspect"}]},{role:"assistant",content:[{type:"tool_use",id:"call-a",name:"inspect",input:{id:"worker"}},{type:"tool_use",id:"call-b",name:"list",input:{}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"call-a",content:"complete"},{type:"tool_result",tool_use_id:"call-b",content:"worker"}]}]});
  expect(JSON.stringify(requests[1])).not.toContain("foreign-provider-continuation");
  expect(final).toContainEqual(expect.objectContaining({type:"text_delta",text:"Worker complete"}));
  expect(final.at(-1)).toMatchObject({type:"finish",finishReason:"stop"});
});

// A truncated stream or wrong credential must fail before the coordinator can
// claim completion or accidentally use a native/subscription credential.
test("fails closed on missing direct credentials, truncation, errors and cancellation",async()=>{
  const input={providerId:"anthropic" as const,settings,secrets,messages:[{role:"user" as const,content:"Hello"}]};
  const fetch=vi.fn(async()=>sse([{type:"message_start",message:{usage:{input_tokens:10}}}]));vi.stubGlobal("fetch",fetch);
  await expect(Array.fromAsync(streamManagedLocalChatCompletion({...input,secrets:{version:1,providers:{}}}))).rejects.toThrow("API-key");expect(fetch).not.toHaveBeenCalled();
  await expect(Array.fromAsync(streamManagedLocalChatCompletion(input))).rejects.toThrow("before the message completed");
  fetch.mockImplementation(async()=>sse([{type:"error",error:{message:"direct-key denied"}}]));
  await expect(Array.fromAsync(streamManagedLocalChatCompletion(input))).rejects.toThrow("[redacted] denied");
  const controller=new AbortController();controller.abort(new Error("cancelled"));
  await expect(Array.fromAsync(streamManagedLocalChatCompletion({...input,signal:controller.signal}))).rejects.toThrow("cancelled");
});


// Discovery must use the same direct credential/endpoint, advance pagination,
// and qualify the configured model without inventing an available model ID.
test("discovers paginated Anthropic models and validates the selected model",async()=>{
  const urls:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(url:URL,init:RequestInit)=>{
    urls.push(String(url));
    expect(init.headers).toMatchObject({"x-api-key":"direct-key"});
    return Response.json(url.searchParams.has("after_id") ? {data:[{id:"second",display_name:"Second"}],has_more:false} : {data:[{id:"configured-claude",display_name:"Configured Claude",max_input_tokens:200000,max_tokens:4096}],has_more:true,last_id:"configured-claude"});
  }));
  const models=await listAnthropicProviderModels({settings,secrets});
  expect(models.map(model=>model.id)).toEqual(["configured-claude","second"]);
  expect(models[0]).toMatchObject({providerId:"anthropic",source:"provider",contextWindow:200000,outputLimit:4096,capabilities:{toolCalling:true,vision:true}});
  expect(urls[1]).toContain("after_id=configured-claude");
  expect(await validateAnthropicProvider({settings,secrets,modelId:"missing"})).toMatchObject({ok:false,live:true,modelFound:false});
  expect(await validateAnthropicProvider({settings,secrets})).toMatchObject({ok:true,live:true,modelFound:true});
});

// Recovered background summaries may retain their original credential across
// refresh, but must never move from a subscription login to API-key billing.
test("binds recovered summary inference to its admitted credential source",async()=>{
  const {ponderProviderCredential}=await import("../apps/server/src/openpond/ponder-provider-credential");
  const {createLocalByokChatStream}=await import("../apps/server/src/openpond/local-byok-chat-stream");
  const subscription:ProviderSecrets={version:1,providers:{openai:{...secrets.providers.anthropic!,source:"chatgpt_subscription",value:null,credentialId:"subscription-connection",oauth:{accountId:"account",accessToken:"old",refreshToken:"old-refresh",expiresAt:1}}}};
  const fingerprint=ponderProviderCredential({providerId:"openai",settings,secrets:subscription});
  const refreshed:ProviderSecrets={version:1,providers:{openai:{...subscription.providers.openai!,oauth:{accountId:"account",accessToken:"new",refreshToken:"new-refresh",expiresAt:100}}}};
  expect(ponderProviderCredential({providerId:"openai",settings,secrets:refreshed})).toBe(fingerprint);
  const apiKey:ProviderSecrets={version:1,providers:{openai:{...secrets.providers.anthropic!,credentialId:"api-key-connection"}}};
  expect(ponderProviderCredential({providerId:"openai",settings,secrets:apiKey})).not.toBe(fingerprint);
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const stream=createLocalByokChatStream({home:"/tmp/unused",managedAdapterChatRuntime:{} as never,localByokRuntimeState:async()=>({settings,secrets:apiKey}),providerSecretPaths:{secretsFilePath:"unused",keyFilePath:"unused"},now:()=>new Date().toISOString()});
  await expect(Array.fromAsync(stream({providerId:"openai",modelId:"configured",messages:[{role:"user",content:"Summarize"}],requestId:"summary",expectedPonderHistoryCredential:fingerprint,signal:new AbortController().signal}))).rejects.toThrow("ponder_history_provider_credential_changed");
  expect(fetch).not.toHaveBeenCalled();
});
