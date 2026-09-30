import { z } from "zod";
import type { HostedChatMessage, HostedChatToolCall, HostedChatContinuation, HostedChatUsage } from "@openpond/cloud";
import type { streamOpenPondHostedChatTurn } from "@openpond/runtime";
import type { ExperimentModelCase } from "./experiment-case-contract.js";
import type { ExperimentCasePolicy } from "./experiment-case-service.js";

/** Use the app-server's provider transport with only explicit Experiment
 * configuration. No selected chat session, Profile or personal memory enters. */
export function createLocalExperimentPolicy(input: {
  request: ExperimentModelCase;
  stream: typeof streamOpenPondHostedChatTurn;
  onUsage?(value: {requestId:string;usage:HostedChatUsage}): Promise<void>;
}): ExperimentCasePolicy {
  let ordinal=0;
  const continuations=new Map<number,HostedChatContinuation>();
  return async ({messages,tools,signal}) => {
    const requestId=`experiment:${input.request.id}:${ordinal++}`;
    let assistant=0;
    const wire:HostedChatMessage[]=messages.map(message=> {
      if(message.role === "tool") return {role:"tool",tool_call_id:message.callId,name:message.name,content:JSON.stringify(message.observation)};
      if(message.role === "assistant") {
        const continuation=continuations.get(assistant++);
        return {role:"assistant",content:message.text,...(continuation?{continuation}:{}),
          ...(message.toolCalls.length?{tool_calls:message.toolCalls.map(call=>({id:call.id,type:"function",function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}:{}),
        };
      }
      return {role:message.role,content:message.text};
    });
    let text="",calls:HostedChatToolCall[]=[],continuation:HostedChatContinuation|undefined;
    for await (const delta of input.stream({
      model:input.request.model.modelId,
      messages:[...input.request.model.messages,...wire],
      tools:tools.map(tool=>({type:"function",function:{name:tool.name,description:tool.description,parameters:tool.inputSchema}})),
      requestId,maxTokens:input.request.model.maxOutputTokens,
      temperature:input.request.model.temperature,topP:input.request.model.topP,signal,
    })) {
      signal.throwIfAborted();
      if(delta.type === "text_delta") {
        text+=delta.text;
        if(text.length>262_144) throw new Error("Experiment policy response exceeded its retained-output limit.");
      }
      if(delta.type === "tool_call_delta") {
        calls=delta.toolCalls;
        if(calls.length>200) throw new Error("Experiment policy response exceeded its tool-call limit.");
      }
      if(delta.type === "continuation")continuation=delta.continuation;
      if(delta.type === "usage")await input.onUsage?.({requestId,usage:delta.usage});
    }
    if(continuation)continuations.set(ordinal-1,continuation);
    return {text,toolCalls:calls.map(call=>({
      id:z.string().min(1).parse(call.id),name:z.string().min(1).parse(call.function?.name),
      arguments:z.record(z.string(),z.unknown()).parse(JSON.parse(z.string().parse(call.function?.arguments))),
    }))};
  };
}
