import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,it} from "vitest";
import {SqliteStore} from "./store.js";
import {createSessionStore} from "./session-store.js";
import {createPonderHostedService,type HostedPonderAccess} from "../openpond/ponder-hosted-service.js";

// A lost hosted acceptance must recover one exact assignment after restart;
// cancellation must find an accepted but locally unknown turn, and a changed
// account must never see or control the old account's job or inherit its consent.
it("retains scoped hosted assignment identity through lost responses, restart and account changes",async()=>{
 const home=await mkdtemp(path.join(tmpdir(),"ponder-hosted-"));let store=new SqliteStore(home);
 let account={id:"owner-a",apiBaseUrl:"https://workspace.test",teamId:"team-a"};
 const calls:{path:string;method?:string;body?:Record<string,unknown>;idempotencyKey?:string}[]=[];
 const conversations=new Map<string,string>(),turns=new Map<string,string>();let loseConversation=true,loseTurn=true,cancelled=false;
 const client={audience:account.apiBaseUrl,request:async(input:typeof calls[number])=>{
  calls.push(input);
  if(input.path==="/ponder/capabilities")return {hostedSandbox:{available:true,reason:null}};
  if(input.path==="/conversations"){
   const id=conversations.get(input.idempotencyKey!) ?? "remote-conversation";conversations.set(input.idempotencyKey!,id);
   if(loseConversation){loseConversation=false;throw new Error("lost conversation response");}return {id};
  }
  if(input.path==="/conversations/remote-conversation/turns"){
   const id=turns.get(input.idempotencyKey!) ?? "remote-turn";turns.set(input.idempotencyKey!,id);
   if(loseTurn){loseTurn=false;throw new Error("lost turn response");}return {id,status:"running"};
  }
  if(input.path==="/conversations/remote-conversation")return {id:"remote-conversation",mode:"work",isPonder:false,activeTurn:turns.size?{id:"remote-turn"}:null};
  if(input.path==="/turns/remote-turn/cancel"){cancelled=true;return {id:"remote-turn",status:"cancelled"};}
  if(input.path==="/turns/remote-turn")return {id:"remote-turn",status:cancelled?"cancelled":"running",lastSequence:2,outputs:[]};
  if(input.path.startsWith("/turns/remote-turn/events"))return {items:[{id:"e1",sequence:1,type:"assistant.delta",text:"Bounded "},{id:"e2",sequence:2,type:"assistant.delta",text:"result"}],nextCursor:null};
  throw new Error(`Unexpected remote request ${input.path}`);
 }};
 const service=()=>createPonderHostedService({store,access:async()=>({account,client} as HostedPonderAccess)});
 try{
  const session=await createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}}).createSession({provider:"openai",systemKind:"openpond.ponder",hiddenFromDefaultSidebar:true});
  await store.saveLocalPonderState({id:"coordinator",location:"local",sessionId:session.id,modelRef:{providerId:"openai",modelId:"configured"},revision:1,remoteAccessEnabled:false,hostedSandboxesEnabled:false,hostedActivation:"inactive"});
  const {ponderHostedTools}=await import("../openpond/ponder-hosted-tools.js");
  const {filterModelToolsForExperience}=await import("../runtime/experience-policy.js");
  const launch=async(payload:unknown)=>{const definitions=ponderHostedTools(service());const visible=filterModelToolsForExperience(session,definitions.filter(tool=>tool.enabled?.({session} as never)));const tool=visible.find(tool=>tool.name==="openpond_start_hosted_agent");expect(tool).toBeDefined();const result=await tool!.execute({session,turnId:"coordinator-turn",callId:"start-hosted",args:payload} as never);return result.data as import("@openpond/contracts").PonderHostedAssignment;};
  const input={requestId:"assignment-1",title:"Bounded hosted work",assignment:"Inspect only the explicitly supplied asset",modelId:"configured-hosted-model",attachments:[{id:"scoped-asset",name:"input.txt",contentType:"text/plain",sizeBytes:5}]};
  await expect(launch(input)).rejects.toThrow("local_ponder_hosted_disabled");
  const connected=await service().configure({enabled:true,revision:0,accountId:account.id,apiBaseUrl:account.apiBaseUrl,teamId:account.teamId});
  const offline=createPonderHostedService({store,access:async()=>{throw new Error("offline account lookup");}});
  const disabled=await offline.configure({enabled:false,revision:connected.revision});expect(disabled).toMatchObject({enabled:false,available:true});
  await service().configure({enabled:true,revision:disabled.revision,accountId:account.id,apiBaseUrl:account.apiBaseUrl,teamId:account.teamId});
  const first=await launch(input);expect(first.state).toBe("unknown");expect(first.remoteConversationId).toBeNull();
  await store.close();store=new SqliteStore(home);
  const recovered=await launch(input);expect(recovered.id).toBe(first.id);expect(recovered.remoteConversationId).toBe("remote-conversation");expect(recovered.remoteTurnId).toBeNull();
  await expect(launch({...input,assignment:"Changed body"})).rejects.toThrow("local_ponder_hosted_assignment_conflict");
  const stopped=await service().cancel(first.id);expect(stopped.assignment.state).toBe("cancelled");expect(stopped.assignment.remoteTurnId).toBe("remote-turn");expect(stopped.assignment.canCancel).toBe(false);
  expect(stopped.events).toEqual([{id:"e1",sequence:1,type:"assistant.delta",text:"Bounded result"}]);
  expect(conversations.size).toBe(1);expect(turns.size).toBe(1);
  expect(calls.filter(call=>call.path.endsWith("/turns")&&call.method==="POST")).toHaveLength(1);
  const remoteBody=calls.find(call=>call.path.endsWith("/turns")&&call.method==="POST")!.body!;
  expect(Object.keys(remoteBody).sort()).toEqual(["attachments","modelId","prompt"]);
  expect(remoteBody.attachments).toEqual(input.attachments);expect(remoteBody.prompt).toBe(input.assignment);
  const priorRevision=(await service().status()).revision;
  account={id:"owner-b",apiBaseUrl:"https://workspace.test",teamId:"team-b"};
  expect((await service().status()).enabled).toBe(false);expect((await service().list()).items).toEqual([]);
  await expect(service().detail(first.id)).rejects.toThrow("local_ponder_hosted_account_changed");
  await expect(service().configure({enabled:true,revision:priorRevision,accountId:"owner-a",apiBaseUrl:account.apiBaseUrl,teamId:"team-a"})).rejects.toThrow("local_ponder_hosted_workspace_changed");
  await service().configure({enabled:true,revision:priorRevision,accountId:account.id,apiBaseUrl:account.apiBaseUrl,teamId:account.teamId});
  await expect(launch(input)).rejects.toThrow("local_ponder_hosted_assignment_conflict");
 }finally{await store.close();await rm(home,{recursive:true,force:true});}
});

// Cancellation after an uncertain conversation creation cannot leave paid work
// behind: a turn is never submitted until its conversation ID commits locally.
// Conversely, cancellation of a lost already-completed turn finds its retained
// terminal receipt rather than re-submitting the assignment.
it("settles cancellation uncertainty without dispatching a new hosted turn",async()=>{
 const home=await mkdtemp(path.join(tmpdir(),"ponder-hosted-cancel-"));const store=new SqliteStore(home);
 const account={id:"owner",apiBaseUrl:"https://workspace.test",teamId:"team"};let loseConversation=true,completed=false,turnPosts=0,cancelPosts=0;
 const client={audience:account.apiBaseUrl,request:async(input:{path:string;method?:string})=>{
  if(input.path==="/ponder/capabilities")return {hostedSandbox:{available:true,reason:null}};
  if(input.path==="/conversations"){if(loseConversation){loseConversation=false;throw new Error("lost response");}return {id:"conversation"};}
  if(input.path==="/conversations/conversation/turns"){turnPosts++;completed=true;throw new Error("lost completed turn response");}
  if(input.path==="/conversations/conversation")return {id:"conversation",mode:"work",isPonder:false,activeTurn:completed?{id:"completed-turn"}:null};
  if(input.path==="/turns/completed-turn/cancel"){cancelPosts++;return {};}
  if(input.path==="/turns/completed-turn")return {id:"completed-turn",status:"completed",outputs:[],wait:null};
  if(input.path.startsWith("/turns/completed-turn/events"))return {items:[],nextCursor:null};
  throw new Error(input.path);
 }};
 try{
  const session=await createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}}).createSession({provider:"openai",systemKind:"openpond.ponder"});
  await store.saveLocalPonderState({id:"coordinator",location:"local",sessionId:session.id,modelRef:{providerId:"openai",modelId:"model"},revision:1,remoteAccessEnabled:false,hostedSandboxesEnabled:false,hostedActivation:"inactive"});
  const service=createPonderHostedService({store,access:async()=>({account,client} as HostedPonderAccess)});
  await service.configure({enabled:true,revision:0,accountId:account.id,apiBaseUrl:account.apiBaseUrl,teamId:account.teamId});
  const input={requestId:"before-turn",title:"Bounded",assignment:"Scoped task",modelId:"configured"};
  const before=await service.start(session.id,input);expect(before.state).toBe("unknown");expect((await service.cancel(before.id)).assignment.state).toBe("cancelled");expect(turnPosts).toBe(0);
  const accepted=await service.start(session.id,{...input,requestId:"completed-turn"});expect(accepted.remoteTurnId).toBeNull();
  expect((await service.cancel(accepted.id)).assignment.state).toBe("completed");expect(turnPosts).toBe(1);expect(cancelPosts).toBe(1);
 }finally{await store.close();await rm(home,{recursive:true,force:true});}
});

// The upload boundary may read only the exact authorized project file; retries
// recover the same verified remote input without leaking a changed file/account.
it("stages only a scoped project asset and recovers its verified descriptor across response loss",async()=>{
 const {writeFile,symlink}=await import("node:fs/promises");const {vi}=await import("vitest");
 const {stagePonderHostedInput}=await import("../openpond/ponder-hosted-inputs.js");
 const home=await mkdtemp(path.join(tmpdir(),"ponder-hosted-assets-"));const outside=await mkdtemp(path.join(tmpdir(),"ponder-hosted-outside-"));const store=new SqliteStore(home);
 const account={id:"owner",apiBaseUrl:"https://workspace.test",teamId:"team"};let planCalls=0,losePlan=true;const remoteKeys=new Set<string>();let puts=0;
 const descriptor={id:"verified-input",name:"input.txt",contentType:"text/plain",sizeBytes:5};
 const access={account,client:{audience:account.apiBaseUrl,request:async(input:{path:string;idempotencyKey?:string;body?:Record<string,unknown>})=>{
  if(input.path==="/work-inputs"){planCalls++;remoteKeys.add(input.idempotencyKey!);expect(input.body).toMatchObject({name:"input.txt",contentType:"text/plain",sizeBytes:5});expect(input.body?.sha256Base64).toBeTruthy();if(losePlan){losePlan=false;throw new Error("lost plan");}return {input:descriptor,upload:{url:"https://upload.test/scoped",method:"PUT",headers:{"content-type":"text/plain"}}};}
  if(input.path==="/work-inputs/verified-input/finalize")return descriptor;
  throw new Error(input.path);
 }}} as HostedPonderAccess;
 const deps={store,access,coordinatorId:"coordinator",projects:async()=>[{id:"project",workspacePath:home}]};
 const input={requestId:"asset-1",projectId:"project",relativePath:"input.txt",contentType:"text/plain"};
 try{
  await writeFile(path.join(home,"input.txt"),"HELLO");await writeFile(path.join(outside,"secret.txt"),"NEVER_UPLOAD");await symlink(path.join(outside,"secret.txt"),path.join(home,"escaped.txt"));
  vi.stubGlobal("fetch",async(_url:unknown,init:RequestInit)=>{puts++;expect(Buffer.from(init.body as Uint8Array).toString()).toBe("HELLO");return new Response(null,{status:200});});
  await expect(stagePonderHostedInput(deps,{...input,relativePath:"escaped.txt"})).rejects.toThrow("local_ponder_hosted_asset_outside_project");expect(planCalls).toBe(0);
  await expect(stagePonderHostedInput(deps,input)).rejects.toThrow("lost plan");
  expect(await stagePonderHostedInput(deps,input)).toEqual(descriptor);
  expect(await stagePonderHostedInput(deps,input)).toEqual(descriptor);expect(remoteKeys.size).toBe(1);expect(planCalls).toBe(2);expect(puts).toBe(1);
  await writeFile(path.join(home,"input.txt"),"OTHER");await expect(stagePonderHostedInput(deps,input)).rejects.toThrow("local_ponder_hosted_asset_conflict");expect(planCalls).toBe(2);
 }finally{vi.unstubAllGlobals();await store.close();await rm(home,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

// A process can lose the completion acknowledgement after durable inbox
// acceptance. Retrying after restart must reuse one runtime follow-up receipt,
// preserving the hosted output references without inventing a worker session.
it("delivers terminal hosted work once through the durable coordinator inbox across retry",async()=>{
 const {createTaskInboxRuntime}=await import("../runtime/task-inbox/runtime.js");
 const home=await mkdtemp(path.join(tmpdir(),"ponder-hosted-inbox-"));const store=new SqliteStore(home);
 const sessions=createSessionStore({store,defaultSessionCwd:()=>home,appendRuntimeEvent:async()=>{}});
 const account={id:"owner",apiBaseUrl:"https://workspace.test",teamId:"team"};
 let releaseTurn!:()=>void;let markTurn!:()=>void;const turnGate=new Promise<void>(resolve=>{releaseTurn=resolve;});const turnEntered=new Promise<void>(resolve=>{markTurn=resolve;});let turnPosts=0,outputReads=0;let wrongConversation=false,wrongOutputId=false;
 const client={audience:account.apiBaseUrl,request:async(input:{path:string})=>{
  if(input.path==="/ponder/capabilities")return {hostedSandbox:{available:true,reason:null}};
  if(input.path==="/conversations")return {id:"conversation"};
  if(input.path==="/conversations/conversation/turns"){turnPosts++;markTurn();await turnGate;return {id:"turn",status:"completed"};}
  if(input.path==="/work-outputs/output"){outputReads++;return {id:wrongOutputId?"other-output":"output",conversationID:wrongConversation?"other-conversation":"conversation",name:"result.txt",mediaType:"text/plain",byteCount:5,previewURL:"https://assets.test/result",downloadURL:"https://assets.test/result"};}
  if(input.path==="/turns/turn")return {id:"turn",status:"completed",assistantText:"Verified terminal result",outputs:[{id:"output",name:"result.txt",mediaType:"text/plain",byteCount:5}],wait:null};
  if(input.path.startsWith("/turns/turn/events"))return {items:[{id:"event",sequence:1,type:"assistant.delta",text:"RESULT"}],nextCursor:null};
  throw new Error(input.path);
 }};
 let lostAcknowledgement=true,callbacks=0;
 const inbox=createTaskInboxRuntime({store,getSession:sessions.getSession,listSessions:()=>store.sessionShells(),getTurn:id=>store.getTurn(id),latestTurn:id=>store.latestTurnForSession(id),recoverInterruptedTurn:async()=>{},getSubagentRun:async()=>null,getActiveTurn:()=>undefined,startFollowup:async()=>{throw new Error("No inference in boundary fixture");},appendRuntimeEvent:async event=>{await store.appendRuntimeEvent(event);},yieldWhileWaiting:work=>work(),dispatchFollowup:async()=>{}});
 const service=()=>createPonderHostedService({store,access:async()=>({account,client} as HostedPonderAccess),notifyCompletion:async job=>{
  callbacks++;const receipt=await inbox.admitRuntimeLocalMessage({id:crypto.randomUUID(),sessionId:(await store.localPonderState())!.sessionId!,senderSessionId:null,senderKind:"runtime",kind:"followup",body:`Hosted result ${job.id}`,payload:{localPonderHostedResult:{assignmentId:job.id,account:job.account,outputs:job.outputs.map(output=>({id:output.id,name:output.name}))}},idempotencyKey:`local-ponder-hosted-result:${job.id}`,replyTo:null,expectedTurnId:null});
  if(lostAcknowledgement){lostAcknowledgement=false;throw new Error("lost local receipt acknowledgement");}return receipt.id;
 }});
 try{
  const session=await sessions.createSession({provider:"openai",systemKind:"openpond.ponder"});
  await store.saveLocalPonderState({id:"coordinator",location:"local",sessionId:session.id,modelRef:{providerId:"openai",modelId:"model"},revision:1,remoteAccessEnabled:false,hostedSandboxesEnabled:false,hostedActivation:"inactive"});
  await service().configure({enabled:true,revision:0,accountId:account.id,apiBaseUrl:account.apiBaseUrl,teamId:account.teamId});
  const active=service();const launching=active.start(session.id,{requestId:"completed",title:"Bounded",assignment:"Scoped task",modelId:"configured"});await turnEntered;const polling=active.list();releaseTurn();const job=await launching;await polling;expect(job.state).toBe("completed");expect(job.resultText).toBe("Verified terminal result");expect(turnPosts).toBe(1);
  await service().detail(job.id);await service().detail(job.id);
  const snapshot=await store.taskInboxSnapshot(session.id);expect(snapshot.inputs).toHaveLength(1);expect(snapshot.inputs[0]).toMatchObject({senderKind:"runtime",senderSessionId:null,kind:"followup",payload:{localPonderHostedResult:{assignmentId:job.id,account,outputs:[{id:"output",name:"result.txt"}]}}});
  expect((await store.hostedPonderJobs("coordinator"))[0]?.completionReceiptId).toBe(snapshot.inputs[0]!.id);expect(callbacks).toBe(2);expect(await store.sessionCount()).toBe(1);
  expect(await active.output(job.id,"output")).toMatchObject({id:"output",downloadURL:"https://assets.test/result"});
  await expect(active.output(job.id,"unrelated-output")).rejects.toThrow("local_ponder_hosted_output_not_found");expect(outputReads).toBe(1);
  wrongConversation=true;await expect(active.output(job.id,"output")).rejects.toThrow("local_ponder_hosted_output_mismatch");wrongConversation=false;
  wrongOutputId=true;await expect(active.output(job.id,"output")).rejects.toThrow("local_ponder_hosted_output_mismatch");wrongOutputId=false;
  const anotherAccount=createPonderHostedService({store,access:async()=>({account:{...account,id:"another-owner"},client} as HostedPonderAccess)});
  await expect(anotherAccount.output(job.id,"output")).rejects.toThrow("local_ponder_hosted_account_changed");expect(outputReads).toBe(3);
  expect((await store.hostedPonderJobs("coordinator"))[0]?.outputs[0]?.downloadURL).toBeNull();
 }finally{await inbox.close();await store.close();await rm(home,{recursive:true,force:true});}
});
