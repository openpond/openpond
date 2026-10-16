import {afterEach,expect,test,vi} from "vitest";
import {ProviderSettingsSchema} from "@openpond/contracts";
import {managedModelReasoningEffort} from "../apps/server/src/openpond/managed-model-reasoning";
import {streamOpChatChatCompletion} from "../packages/runtime/src/chat";
afterEach(()=>vi.unstubAllGlobals());

// Switching a coordinator from a reasoning model to an off-only model used to
// forward its saved High/Low setting and produce a real provider400 response.
// Assert the production transport receives a legal destination effort while a
// supported source setting survives switching back.
test("normalizes destination effort before the managed wire request",async()=>{
 const settings=ProviderSettingsSchema.parse({modelCaches:{openpond:{providerId:"openpond",models:[
  {id:"reasoning-source",providerId:"openpond",displayName:"Reasoning",source:"provider",capabilities:{reasoning:true,reasoningEfforts:["low","high"]}},
  {id:"off-destination",providerId:"openpond",displayName:"Off only",source:"provider",capabilities:{reasoning:false,reasoningEfforts:["off"]}},
 ]}}});
 const bodies:Record<string,unknown>[]=[];
 vi.stubGlobal("fetch",vi.fn(async(_url:unknown,init:RequestInit)=>{bodies.push(JSON.parse(String(init.body)));return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}));
 for(const model of ["reasoning-source","off-destination","reasoning-source"]){
  await Array.fromAsync(streamOpChatChatCompletion({apiBaseUrl:"https://example.test/v1",token:"qualification-key",model,messages:[{role:"user",content:"Hello"}],reasoningEffort:managedModelReasoningEffort({provider:"openpond",model,selected:"low",settings})}));
 }
 expect(bodies.map(body=>body.reasoning_effort)).toEqual(["low",undefined,"low"]);
 expect(bodies[1]).toMatchObject({thinking:{type:"disabled"}});
});
