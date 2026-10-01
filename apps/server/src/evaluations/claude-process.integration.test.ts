import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {retainClaudeProcessEvidence,readClaudeProcessEvents} from "./claude-process-evidence.js";
import {localRetainedAttempt} from "./local-experiment-output.js";
import {NodeSqliteConnection} from "../store/sqlite/sqlite-driver-node.js";
import type {LocalModelStreamScope} from "./local-experiment-model.js";
import {createClaudeProcessStream,type ClaudeLiveSession} from "./claude-process-runtime.js";
// Failure story: actual process stdout must remain bounded, exact-session and
// secret-free; cancelling a live stream must reap its process rather than accept
// partial output. This protocol fixture does not qualify an installed Claude CLI.
test("process supervisor retains real UTF8 session events and kills cancelled children",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"claude-protocol-")),executable=path.join(directory,"fixture"),db=new NodeSqliteConnection(path.join(directory,"events.sqlite"));db.exec("CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,payload TEXT)");
 await writeFile(executable,`#!${process.execPath}
const readline=require('node:readline');
const args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1],model=args[args.indexOf('--model')+1];
const descendant=process.platform==='win32'?null:require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
const write=value=>process.stdout.write(JSON.stringify({...value,session_id:session})+'\\n');
let ready=false;const pending=[];
const respond=line=>{const value=JSON.parse(line);write({type:'user',message:value.message});write({type:'result',is_error:false,result:'observed café 🐟',total_cost_usd:0.001,usage:{input_tokens:2,output_tokens:3}});};
const init=()=>{write({type:'system',subtype:'init',model,tools:[],mcp_servers:[],descendantPid:descendant?.pid,diagnostic:process.env.ANTHROPIC_API_KEY});ready=true;pending.splice(0).forEach(respond);};
if(descendant)descendant.once('message',init);else init();
process.stderr.write(process.env.ANTHROPIC_API_KEY);
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>ready?respond(line):pending.push(line));
input.on('close',()=>process.exit(0));`,{mode:0o700});
 let active:ClaudeLiveSession|null=null;const store={async appendLocalExperimentEvent(value:{type:string;payload:unknown}){db.run("INSERT INTO events(type,payload) VALUES(?,?)",[value.type,JSON.stringify(value.payload)]);},async localExperimentTrace(input:{afterSequence?:number;limit:number}){const rows=db.all<{sequence:number;type:string;payload:string}>("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",[input.afterSequence??0,input.limit+1]);return{items:rows.slice(0,input.limit).map(row=>({...row,payload:JSON.parse(row.payload)})),nextCursor:rows.length>input.limit?rows[input.limit-1]!.sequence:null};}} as LocalModelStreamScope["store"];
 const scope={store,ownerId:"owner",teamId:"team",executionId:"execution",caseId:"receipt",actorId:"actor",async authorize(){},async control(){return{replay:false,state:"prepared" as const};}};
 const runtime={providerId:"claude-code" as const,configurationHash:"1".repeat(64),executableHash:"2".repeat(64),version:"2.1.217",capabilityHash:"3".repeat(64),maximumRequestCostUsd:1,requestTimeoutMs:5000,maximumTurns:3,holdOpen:true};
 const stream=createClaudeProcessStream({scope,executable,apiKey:"protected-api-key",modelId:"exact-model",runtime,setActive(value){active=value;}});
 const controllers:AbortController[]=[],streams:Promise<unknown>[]=[];
 try{
 const consume=async(requestId:string,signal:AbortSignal)=>{const events=[];for await(const event of stream({requestId,model:"exact-model",maxTokens:100,messages:[{role:"user",content:"fixture protocol"}],signal}))events.push(event);return events;};
 const controller=new AbortController(),result=consume("one",controller.signal);controllers.push(controller);streams.push(result);void result.catch(()=>{});
 await waitFor(()=>Boolean(db.get("SELECT payload FROM events WHERE type='external.stream' AND payload LIKE '%result%'")));
 expect(active).not.toBeNull();await active!.send("message","owner clarification");await waitFor(()=>db.all("SELECT payload FROM events WHERE type='external.stream' AND payload LIKE '%result%'").length===2);await active!.send("seal");
 const emitted=await result;expect(emitted.find(event=>event.type==="text_delta")).toMatchObject({text:"observed café 🐟"});expect(emitted.at(-1)?.type).toBe("finish");const firstPid=JSON.parse(db.get<{payload:string}>("SELECT payload FROM events WHERE type='external.process'")!.payload).pid;expect(()=>process.kill(firstPid,0)).toThrow();
 if(process.platform!=="win32"){const descendantPid=JSON.parse(db.get<{payload:string}>("SELECT payload FROM events WHERE type='external.stream' AND payload LIKE '%descendantPid%'")!.payload).event.descendantPid;await waitFor(()=>!running(descendantPid));}
 const body={taskId:"task",status:"completed",output:"observed café 🐟",error:null,messages:[],environmentCleanupComplete:true};const retained=await retainClaudeProcessEvidence({store,teamId:"team",executionId:"execution",caseId:"receipt",attempt:{...body,contentHash:contentHash(body)}});const trace=await readClaudeProcessEvents({store,teamId:"team",executionId:"execution",caseId:"receipt"});expect(retained.externalProcess.traceHash).toBe(contentHash(trace));expect(retained.externalProcess.runtimeEventRefs).toEqual(trace.map(event=>String(event.sequence)));expect(retained.externalProcess.cleanupComplete).toBe(true);expect(localRetainedAttempt(retained).externalProcess?.sessionId).toBe(retained.externalProcess.sessionId);const {contentHash:old,...changed}=retained;void old;const corrupted={...changed,output:"different output"};expect(()=>localRetainedAttempt({...corrupted,contentHash:contentHash(corrupted)})).toThrow("exact output");
 db.run("DELETE FROM events");const abort=new AbortController(),cancelled=consume("two",abort.signal);controllers.push(abort);streams.push(cancelled);void cancelled.catch(()=>{});await waitFor(()=>Boolean(db.get("SELECT payload FROM events WHERE type='external.stream' AND payload LIKE '%result%'")));const cancelledPid=JSON.parse(db.get<{payload:string}>("SELECT payload FROM events WHERE type='external.process'")!.payload).pid;abort.abort(new Error("explicit cancellation"));await expect(cancelled).rejects.toThrow("explicit cancellation");expect(()=>process.kill(cancelledPid,0)).toThrow();if(process.platform!=="win32"){const descendantPid=JSON.parse(db.get<{payload:string}>("SELECT payload FROM events WHERE type='external.stream' AND payload LIKE '%descendantPid%'")!.payload).event.descendantPid;await waitFor(()=>!running(descendantPid));}expect(JSON.stringify(db.all("SELECT * FROM events"))).not.toContain("protected-api-key");
 }finally{for(const controller of controllers)controller.abort(new Error("Fixture cleanup"));await Promise.allSettled(streams);db.close();await rm(directory,{recursive:true,force:true});}
});
async function waitFor(test:()=>boolean){const deadline=Date.now()+5000;while(!test()){if(Date.now()>deadline)throw new Error("Actual subprocess evidence did not arrive.");await new Promise(resolve=>setTimeout(resolve,10));}}

function running(pid:number){try{process.kill(pid,0);if(process.platform==="linux"&&/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`,"utf8")))return false;return true;}catch{return false;}}
