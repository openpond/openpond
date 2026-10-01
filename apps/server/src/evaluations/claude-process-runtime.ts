import {spawn,type ChildProcess} from "node:child_process";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {StringDecoder} from "node:string_decoder";
import {CLAUDE_PROCESS_CHILD_SOURCE} from "./claude-process-child.js";
import {contentHash} from "@openpond/harness";
import type {HostedChatUsage} from "@openpond/cloud";
import type {streamOpenPondHostedChatTurn} from "@openpond/runtime";
import type {ClaudeCodeRuntime} from "openpond-sdk/experiments";
import type {LocalModelStreamScope} from "./local-experiment-model.js";
import {LocalExperimentError} from "./local-experiment-contract.js";
export type ClaudeProcessScope=LocalModelStreamScope&{actorId:string;authorize():Promise<void>;control(input:{sessionId:string;operationId:string;action:"message"|"seal";text?:string;phase:"prepare"|"acknowledge"}):Promise<{replay:boolean;state:"prepared"|"acknowledged"}>};
export type ClaudeLiveSession={sessionId:string;validate(action:"message"|"seal",text?:string):Promise<void>;send(action:"message"|"seal",text?:string,operationId?:string):Promise<void>};
function fail(message:string):never{throw new LocalExperimentError("claude_process_boundary",message,422);}
export function createClaudeProcessStream(input:{scope:ClaudeProcessScope;executable:string;apiKey:string;modelId:string;runtime:ClaudeCodeRuntime;setActive(session:ClaudeLiveSession|null):void}):typeof streamOpenPondHostedChatTurn{
 return async function*(request){
  if(request.tools?.length)fail("This Claude adapter has no admitted Dataset tool owner.");if(!request.requestId||request.model!==input.modelId)fail("Claude dispatch must retain its exact request/model identity.");
  const prompt=JSON.stringify(request.messages);if(Buffer.byteLength(prompt)>1048576)fail("Claude policy-visible input exceeds its retained input limit.");
  await input.scope.authorize();request.signal?.throwIfAborted();
  const hash=contentHash([input.scope.executionId,input.scope.caseId,request.requestId]),sessionId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const directory=await mkdtemp(path.join(tmpdir(),"openpond-claude-"));await mkdir(path.join(directory,"config"),{mode:0o700});
  const record=(type:string,payload:unknown)=>input.scope.store.appendLocalExperimentEvent({...input.scope,id:input.scope.executionId,type,payload});
  const args=["--bare","-p","--input-format","stream-json","--output-format","stream-json","--verbose","--include-partial-messages","--session-id",sessionId,"--model",input.modelId,"--permission-mode","dontAsk","--tools","","--disallowedTools","mcp__*","--strict-mcp-config","--mcp-config",'{"mcpServers":{}}',"--max-turns",String(input.runtime.maximumTurns),"--max-budget-usd",String(input.runtime.maximumRequestCostUsd)];
  let worker:ChildProcess|undefined,done=false,closed=false,failure:Error|undefined,initialized=false,sealing=false,pendingInputs=1,resultText:string|undefined,usage:HostedChatUsage|undefined,retainedBytes=0,eventCount=0,turns=0,line="",cliPid:number|undefined,cleanupRecorded=false;
  const decoder=new StringDecoder("utf8"),queue:{type:string;[key:string]:unknown}[]=[];let wake:(()=>void)|undefined;
  const controls=new Map<string,{resolve():void;reject(error:Error):void}>();
  const send=(message:unknown)=>new Promise<void>((resolve,reject)=>{if(!worker?.connected)return reject(new Error("Claude process control is unavailable."));worker.send(message as object,error=>error?reject(error):resolve());});
  const sendControl=async(message:object,controlId:string)=>{const acknowledgement=new Promise<void>((resolve,reject)=>{controls.set(controlId,{resolve,reject});});try{await send({...message,controlId});await acknowledgement;}finally{controls.delete(controlId);}};
  const cancel=()=>{if(worker?.connected)worker.send({type:"cancel"});};
  const abort=()=>{failure=request.signal?.reason instanceof Error?request.signal.reason:new Error("Claude process cancelled.");cancel();};
  try{
   await record("external.start",{provider:"claude-code",sessionId,requestId:request.requestId,modelId:input.modelId,executableHash:input.runtime.executableHash,version:input.runtime.version,capabilityHash:input.runtime.capabilityHash,tools:[],sourceHash:contentHash(request.messages),configurationHash:input.runtime.configurationHash,holdOpen:input.runtime.holdOpen,runtime:input.runtime,startedAt:new Date().toISOString()});
   worker=spawn(process.execPath,["-e",CLAUDE_PROCESS_CHILD_SOURCE],{stdio:["ignore","ignore","ignore","ipc"],shell:false,windowsHide:true,env:{PATH:process.env.PATH??"",...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}});
   worker.on("message",message=>{const event=message as {type:string;controlId?:string;ok?:boolean};if(event.type==="control_ack"){const receipt=event.controlId?controls.get(event.controlId):undefined;if(event.ok)receipt?.resolve();else receipt?.reject(new Error("Claude process rejected its input transport."));return;}queue.push(event);wake?.();});worker.once("error",()=>{failure=new Error("Claude process supervisor could not start.");done=true;wake?.();});worker.once("close",()=>{closed=true;done=true;for(const receipt of controls.values())receipt.reject(new Error("Claude process ended before acknowledging control delivery."));wake?.();});request.signal?.addEventListener("abort",abort,{once:true});
   await send({type:"start",executable:input.executable,args,cwd:directory,timeoutMs:input.runtime.requestTimeoutMs,env:{PATH:process.env.PATH??"",...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),ANTHROPIC_API_KEY:input.apiKey,CLAUDE_CONFIG_DIR:path.join(directory,"config"),CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(request.maxTokens),CLAUDE_CODE_MAX_RETRIES:"0",DISABLE_AUTOUPDATER:"1"}});
   const userLine=(text:string)=>JSON.stringify({type:"user",session_id:sessionId,message:{role:"user",content:text}})+"\n";
   await send({type:"input",line:userLine(prompt)});
   const validate=async(action:"message"|"seal",text?:string)=>{await input.scope.authorize();if(done||sealing||!initialized)fail("Claude session is unavailable or sealed.");if(action==="seal"){if(pendingInputs||resultText===undefined)fail("Wait for the current Claude turn result before sealing.");}else{if(!input.runtime.holdOpen)fail("Human intervention requires an explicitly interactive Claude run.");if(!text?.trim()||Buffer.byteLength(text)>262144)fail("Human intervention is empty or exceeds its admitted bound.");if(turns+1>=input.runtime.maximumTurns)fail("Human interventions exceed the admitted turn limit.");}};
   input.setActive({sessionId,validate,async send(action,text,operationId){await validate(action,text);const controlId=operationId??contentHash([sessionId,action,turns,text??null]);if(action==="seal"){sealing=true;await sendControl({type:"seal"},controlId);}else{turns++;pendingInputs++;await sendControl({type:"input",line:userLine(text!)},controlId);}}});
   while(!done||queue.length){if(!queue.length){await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;continue;}const event=queue.shift()!;
    if(event.type==="stdout"){
     const bytes=Buffer.from(String(event.base64),"base64");retainedBytes+=bytes.length;if(retainedBytes>33554432)fail("Claude trace exceeds its 32 MiB retained limit.");line+=decoder.write(bytes);if(Buffer.byteLength(line)>2097152)fail("Claude stream line exceeds its 2 MiB limit.");
     let newline:number;while((newline=line.indexOf("\n"))>=0){const text=line.slice(0,newline);line=line.slice(newline+1);if(!text.trim())continue;if(++eventCount>10000)fail("Claude stream exceeds its event limit.");const raw=JSON.parse(text.split(input.apiKey).join("[redacted credential]")) as Record<string,unknown>;if(raw.session_id!==undefined&&raw.session_id!==sessionId)fail("Claude output changed its admitted session.");
      if(raw.type==="system"&&raw.subtype==="init"){if(raw.model!==input.modelId||Array.isArray(raw.mcp_servers)&&raw.mcp_servers.length||Array.isArray(raw.tools)&&raw.tools.some(tool=>tool!=="EndConversation"))fail("Claude initialized unexpected model, tools or MCP authority.");initialized=true;}
      if(raw.type==="assistant"){const message=raw.message as {model?:string;content?:{type?:string}[]}|undefined;if(message?.model&&message.model!==input.modelId||message?.content?.some(block=>block.type==="tool_use"))fail("Claude attempted an unadmitted model/tool dispatch.");}
      await record("external.stream",{sessionId,event:raw});
      if(raw.type==="result"){if(!initialized||raw.is_error===true||typeof raw.result!=="string")fail("Claude did not return a successful initialized result.");if(Buffer.byteLength(raw.result)>262144)fail("Claude final output exceeds its retained output limit.");if(typeof raw.total_cost_usd==="number"&&raw.total_cost_usd>input.runtime.maximumRequestCostUsd)fail("Claude reported spend above its admitted request allocation.");resultText=raw.result;usage=raw.usage as HostedChatUsage|undefined;pendingInputs=Math.max(0,pendingInputs-1);if(!input.runtime.holdOpen&&!sealing){sealing=true;await send({type:"seal"});}}
     }
     await send({type:"ack_stdout"});
    }else if(event.type==="stderr"){const bytes=Buffer.from(String(event.base64),"base64");retainedBytes+=bytes.length;if(retainedBytes>33554432)fail("Claude diagnostic output exceeds its retained limit.");await record("external.stderr",{sessionId,text:bytes.toString("utf8").split(input.apiKey).join("[redacted credential]")});await send({type:"ack_stderr"});}
    else if(event.type==="started"){cliPid=typeof event.pid==="number"?event.pid:undefined;await record("external.process",{sessionId,pid:event.pid});}
    else if(event.type==="error")failure=new Error("Claude process could not start.");
    else if(event.type==="closed"){done=true;await record("external.cleanup",{sessionId,code:event.code,signal:event.signal,confirmed:true,completedAt:new Date().toISOString()});cleanupRecorded=true;if(event.code!==0&&!failure)failure=new Error("Claude process ended before successful completion.");}
   }
   if(failure)throw failure;if(!sealing||pendingInputs||resultText===undefined||line.trim())fail("Claude stopped with incomplete or unsealed evidence.");
   if(usage)yield{type:"usage",usage,raw:{provider:"claude-code",sessionId}};yield{type:"text_delta",text:resultText,raw:{provider:"claude-code",sessionId}};yield{type:"finish",finishReason:"stop",raw:{provider:"claude-code",sessionId}};
  }finally{input.setActive(null);request.signal?.removeEventListener("abort",abort);if(!closed){cancel();await new Promise<void>(resolve=>{if(!worker||closed)return resolve();const timer=setTimeout(()=>{if(cliPid&&process.platform!=="win32"){try{process.kill(-cliPid,"SIGKILL");}catch{}}worker?.disconnect();const timer=setTimeout(()=>{worker?.kill("SIGKILL");resolve();},1000);worker?.once("close",()=>{clearTimeout(timer);resolve();});},5000);worker.once("close",()=>{clearTimeout(timer);resolve();});});}if(!cleanupRecorded){const cleanup=queue.find(event=>event.type==="closed");if(cleanup)await record("external.cleanup",{sessionId,code:cleanup.code,signal:cleanup.signal,confirmed:true,completedAt:new Date().toISOString()});}await rm(directory,{recursive:true,force:true});}
 };
}
