import {stagePonderHostedInput} from "./ponder-hosted-inputs.js";
import {createHash} from "node:crypto";
import {z} from "zod";
import {TaskSerialExecutor} from "@openpond/agent-runtime/task-signals";
import type {PonderHostedAssignment,PonderHostedAssignmentDetail,PonderHostedSandboxState} from "@openpond/contracts";
import type {SqliteStore} from "../store/store.js";
import type {HostedPonderBinding,HostedPonderJob} from "../store/store-ponder-hosted.js";
import type {HostedPonderAccess} from "./ponder-hosted-access.js";
export type {HostedPonderAccess} from "./ponder-hosted-access.js";
export const HostedAssignmentInput=z.object({requestId:z.string().min(1).max(200),title:z.string().trim().min(1).max(200),assignment:z.string().trim().min(1).max(48000),modelId:z.string().min(1).max(200),reasoningEffort:z.enum(["off","low","medium","high","xhigh","max"]).optional(),attachments:z.array(z.object({id:z.string().min(1).max(200),name:z.string().min(1).max(255),contentType:z.string().min(1).max(200),sizeBytes:z.number().int().min(0).max(10000000)}).strict()).max(20).default([])}).strict();
const same=(left:HostedPonderBinding|null,right:HostedPonderBinding|null)=>JSON.stringify(left)===JSON.stringify(right);
export function createPonderHostedService(deps:{store:SqliteStore;access:()=>Promise<HostedPonderAccess|null>;projects?:()=>Promise<{id:string;workspacePath:string}[]>;notifyCompletion?:(job:HostedPonderJob)=>Promise<string>}){
 const serial=new TaskSerialExecutor();
 const capabilitySnapshots=new Map<string,{available:boolean;reason:string|null}>();
 const lifecycle=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let monitoring:Promise<unknown>|undefined;let closed=false;
 async function deliver(job:HostedPonderJob){
  if(!["completed","failed","cancelled"].includes(job.state)||job.completionReceiptId||!deps.notifyCompletion)return job;
  await authorized(job);
  try{const receipt=await deps.notifyCompletion(job);return await persist(job,{completionReceiptId:receipt,deliveryError:null});}
  catch(error){return persist(job,{deliveryError:error instanceof Error?error.message:String(error)});}
 }
 async function settled(job:HostedPonderJob,access:HostedPonderAccess){return deliver(await refresh(job,access));}
 async function coordinator(){const value=await deps.store.localPonderState();if(!value?.sessionId)throw new Error("local_ponder_unavailable");return value;}
 async function status():Promise<PonderHostedSandboxState>{
  const current=await coordinator(),saved=await deps.store.hostedPonderConnection(current.id),access=await deps.access();
  if(!access)return {enabled:false,revision:saved.revision,account:null,available:false,reason:"Sign in to connect hosted sandboxes."};
  const capability=await access.client.request({signal:lifecycle.signal,path:"/ponder/capabilities"});
  const hosted=z.object({hostedSandbox:z.object({available:z.boolean(),reason:z.string().nullable()})}).parse(capability).hostedSandbox;
  capabilitySnapshots.set(JSON.stringify(access.account),hosted);
  const changed=saved.enabled&&!same(saved.account,access.account);
  return {enabled:saved.enabled&&!changed,revision:saved.revision,account:access.account,available:hosted.available,reason:changed?"The selected account or workspace changed. Reconnect hosted sandboxes explicitly.":hosted.reason};
 }
 function project(job:HostedPonderJob,authorized=true):PonderHostedAssignment{
  const {id,coordinatorId,title,assignment,state,remoteConversationId,remoteTurnId,lastSequence,resultText,wait,error,createdAt,updatedAt,account}=job;
  return {id,coordinatorId,title,assignment,state,remoteConversationId,remoteTurnId,lastSequence,resultText,wait,error,createdAt,updatedAt,account,canCancel:authorized&&!job.cancelRequested&&!["completed","failed","cancelled"].includes(state)};
 }
 function readableEvents(events:HostedPonderJob["events"]){const rows:HostedPonderJob["events"]=[];for(const event of events){const previous=rows.at(-1);if(previous&&previous.type===event.type&&event.type.includes("delta")&&previous.text!==null&&event.text!==null)previous.text+=event.text;else rows.push({...event});}return rows;}
 async function currentJob(id:string){const current=await coordinator();const job=(await deps.store.hostedPonderJobs(current.id)).find(job=>job.id===id);if(!job)throw new Error("local_ponder_hosted_assignment_not_found");return job;}
 async function authorized(job:HostedPonderJob){const access=await deps.access();if(!access||!same(job.account,access.account))throw new Error("local_ponder_hosted_account_changed");return access;}
 async function persist(job:HostedPonderJob,patch:Partial<HostedPonderJob>){return deps.store.saveHostedPonderJob({...job,...patch});}
 function remoteState(status:string):HostedPonderJob["state"]{return status==="completed"?"completed":status==="failed"?"failed":["cancelled","canceled","interrupted"].includes(status)?"cancelled":"running";}
 async function refresh(job:HostedPonderJob,access:HostedPonderAccess){
  if(!job.remoteTurnId)return job;
  const summary=await access.client.request({signal:lifecycle.signal,path:`/turns/${encodeURIComponent(job.remoteTurnId)}`});
  const parsed=z.object({id:z.string(),status:z.string(),assistantText:z.string().nullable().optional(),errorText:z.string().nullable().optional(),lastSequence:z.number().optional(),wait:z.object({id:z.string(),kind:z.string(),title:z.string(),options:z.array(z.unknown()).default([])}).nullable().optional(),outputs:z.array(z.object({id:z.string(),name:z.string(),mediaType:z.string().nullable().optional(),byteCount:z.number().nullable().optional(),previewURL:z.string().nullable().optional(),downloadURL:z.string().nullable().optional()})).optional()}).parse(summary);
  if(parsed.id!==job.remoteTurnId)throw new Error("local_ponder_hosted_remote_identity_changed");
  let cursor:string|undefined;let events=job.events.slice();let lastSequence=job.lastSequence;
  for(let page=0;page<20;page++){
   const result=await access.client.request({signal:lifecycle.signal,path:`/turns/${encodeURIComponent(job.remoteTurnId)}/events?afterSequence=${lastSequence}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
   const body=z.object({items:z.array(z.object({id:z.string(),sequence:z.number().int(),type:z.string(),text:z.string().nullable().optional()})),nextCursor:z.string().nullable()}).parse(result);
   for(const item of body.items){if(item.sequence<=lastSequence)continue;events.push({...item,text:item.text ?? null});lastSequence=item.sequence;}
   if(!body.nextCursor)break;cursor=body.nextCursor;
  }
  return persist(job,{state:parsed.wait?"needs_attention":remoteState(parsed.status),wait:parsed.wait ?? null,resultText:parsed.assistantText ?? job.resultText ?? null,error:parsed.errorText ?? null,lastSequence,events,outputs:(parsed.outputs ?? []).map(output=>({...output,mediaType:output.mediaType ?? null,byteCount:output.byteCount ?? null,previewURL:output.previewURL ?? null,downloadURL:output.downloadURL ?? null}))});
 }
 async function advance(job:HostedPonderJob):Promise<HostedPonderJob>{
  const access=await authorized(job);
  if(["completed","failed","cancelled"].includes(job.state))return await settled(job,access);
  if(job.cancelRequested&&!job.remoteTurnId){
   if(!job.remoteConversationId)return deliver(await persist(job,{state:"cancelled",error:null}));
   if(job.remoteConversationId){const remote=await access.client.request({signal:lifecycle.signal,path:`/conversations/${encodeURIComponent(job.remoteConversationId)}`});
    const conversation=z.object({id:z.string(),mode:z.string(),isPonder:z.boolean(),activeTurn:z.object({id:z.string()}).nullable()}).parse(remote);
    if(conversation.id!==job.remoteConversationId||conversation.mode!=="work"||conversation.isPonder)throw new Error("local_ponder_hosted_remote_identity_changed");
    if(conversation.activeTurn)job=await persist(job,{remoteTurnId:conversation.activeTurn.id});
   }
   if(!job.remoteTurnId)return persist(job,{state:"unknown",error:"Cancellation is pending confirmation of the original hosted submission."});
  }
  try{
   if(!job.remoteTurnId){
    const connection=await deps.store.hostedPonderConnection(job.coordinatorId);
    if(!connection.enabled||!same(connection.account,job.account))return job;
    if(!job.remoteConversationId){
     const created=await access.client.request({signal:lifecycle.signal,path:"/conversations",method:"POST",idempotencyKey:`local-ponder:${job.id}:conversation`,body:{mode:"work"}});
     const id=z.object({id:z.string().min(1)}).parse(created).id;
     job=await persist(job,{remoteConversationId:id,state:"submitting",error:null});
    }
    const submitted=await access.client.request({signal:lifecycle.signal,path:`/conversations/${encodeURIComponent(job.remoteConversationId!)}/turns`,method:"POST",idempotencyKey:`local-ponder:${job.id}:turn`,body:{prompt:job.assignment,modelId:job.request.modelId,...(job.request.reasoningEffort?{reasoningEffort:job.request.reasoningEffort}:{}),attachments:job.request.attachments}});
    const admitted=z.object({id:z.string().min(1),status:z.string()}).parse(submitted);
    job=await persist(job,{remoteTurnId:admitted.id,state:remoteState(admitted.status),error:null});
   }
   if(job.cancelRequested){await access.client.request({signal:lifecycle.signal,path:`/turns/${encodeURIComponent(job.remoteTurnId!)}/cancel`,method:"POST"});}
   return await settled(job,access);
  }catch(error){if(error instanceof Error&&error.message.startsWith("local_ponder_"))throw error;return persist(job,{state:"unknown",error:error instanceof Error?error.message:String(error)});}
 }
 async function list(onlyPending=false){const current=await coordinator(),access=await deps.access();const jobs=(await deps.store.hostedPonderJobs(current.id)).filter(job=>same(job.account,access?.account ?? null)&&(!onlyPending||!["completed","failed","cancelled"].includes(job.state)||!job.completionReceiptId));const items=[];for(const job of jobs){const updated=await serial.run(`job:${job.id}`,async()=>advance(await currentJob(job.id)));items.push(project(updated));}return {items};}
 return {
  startMonitoring(){if(timer||closed)return;const poll=()=>{if(closed)return;monitoring=list(true).catch(()=>{}).finally(()=>{monitoring=undefined;if(!closed){timer=setTimeout(poll,3000);timer.unref();}});};timer=setTimeout(poll,0);timer.unref();},
  async close(){closed=true;if(timer)clearTimeout(timer);lifecycle.abort(new Error("local_ponder_hosted_closing"));await monitoring;},
  assertCompletionScope:async(payload:unknown)=>{const input=z.object({assignmentId:z.string(),account:z.object({id:z.string(),apiBaseUrl:z.string(),teamId:z.string().nullable()})}).parse(payload);const job=await currentJob(input.assignmentId);if(!same(input.account,job.account))throw new Error("local_ponder_hosted_account_changed");await authorized(job);},
  output:async(id:string,outputId:string):Promise<PonderHostedAssignmentDetail["outputs"][number]>=>{
   const job=await currentJob(id),access=await authorized(job);
   if(!job.remoteConversationId||!job.outputs.some(output=>output.id===outputId))throw new Error("local_ponder_hosted_output_not_found");
   const output=z.object({id:z.string(),conversationID:z.string(),name:z.string(),mediaType:z.string().nullable(),byteCount:z.number().nullable(),previewURL:z.string().url().nullable(),downloadURL:z.string().url()}).parse(await access.client.request({signal:lifecycle.signal,path:`/work-outputs/${encodeURIComponent(outputId)}`}));
   if(output.id!==outputId||output.conversationID!==job.remoteConversationId)throw new Error("local_ponder_hosted_output_mismatch");
   await authorized(job);
   return {id:output.id,name:output.name,mediaType:output.mediaType,byteCount:output.byteCount,previewURL:output.previewURL,downloadURL:output.downloadURL};
  },
  status,  assertSession:async(sessionId:string)=>{if((await coordinator()).sessionId!==sessionId)throw new Error("local_ponder_required");},
  stageInput:(sessionId:string,payload:unknown)=>serial.run("input",async()=>{const current=await coordinator();if(sessionId!==current.sessionId)throw new Error("local_ponder_required");const access=await deps.access(),connection=await deps.store.hostedPonderConnection(current.id);if(!access||!connection.enabled||!same(connection.account,access.account))throw new Error("local_ponder_hosted_disabled");return stagePonderHostedInput({store:deps.store,access,coordinatorId:current.id,projects:deps.projects ?? (async()=>[])},payload);}),
  configure:(payload:unknown)=>serial.run("connection",async()=>{
   const input=z.object({enabled:z.boolean(),revision:z.number().int().nonnegative(),teamId:z.string().nullable().optional(),accountId:z.string().optional(),apiBaseUrl:z.string().optional()}).strict().parse(payload);const current=await coordinator();
   if(!input.enabled){
    const existing=await deps.store.hostedPonderConnection(current.id);
    const capability=capabilitySnapshots.get(JSON.stringify(existing.account)) ?? existing.capability;
    const saved=await deps.store.configureHostedPonderConnection(current.id,input.revision,false,existing.account,capability);
    return {enabled:false,revision:saved.revision,account:saved.account,available:capability?.available ?? false,reason:capability?.reason ?? (capability?null:"Reconnect to check workspace availability.")};
   }
   const access=await deps.access();let hosted:{available:boolean;reason:string|null};
   if(input.enabled){if(!access)throw new Error("local_ponder_hosted_account_unavailable");if(input.accountId!==access.account.id||input.apiBaseUrl!==access.account.apiBaseUrl||input.teamId!==access.account.teamId)throw new Error("local_ponder_hosted_workspace_changed");const capability=await access.client.request({signal:lifecycle.signal,path:"/ponder/capabilities"});hosted=z.object({hostedSandbox:z.object({available:z.boolean(),reason:z.string().nullable()})}).parse(capability).hostedSandbox;capabilitySnapshots.set(JSON.stringify(access.account),hosted);if(!hosted.available)throw new Error("local_ponder_hosted_entitlement_unavailable");}
   const saved=await deps.store.configureHostedPonderConnection(current.id,input.revision,true,access!.account,hosted!);
   return {enabled:saved.enabled,revision:saved.revision,account:saved.account,available:hosted!.available,reason:hosted!.reason};
  }),
  list,
  discover:async()=>{const state=await status();if(!state.enabled||!state.available) return {connection:state,models:[]};const access=await deps.access();return {connection:state,catalog:await access!.client.request({signal:lifecycle.signal,path:"/models/catalog?experience=work"})};},
  start:(sessionId:string,payload:unknown)=>serial.run("start",async()=>{
   const input=HostedAssignmentInput.parse(payload),current=await coordinator();if(current.sessionId!==sessionId)throw new Error("local_ponder_required");
   const access=await deps.access(),connection=await deps.store.hostedPonderConnection(current.id);if(!access||!connection.enabled||!same(connection.account,access.account))throw new Error("local_ponder_hosted_disabled");
   const creationKey=`${current.id}:${input.requestId}`,payloadHash=createHash("sha256").update(JSON.stringify({input,account:access.account})).digest("hex");
   const stamp=new Date().toISOString();const job=await deps.store.reserveHostedPonderJob({id:createHash("sha256").update(creationKey).digest("hex").slice(0,32),coordinatorId:current.id,title:input.title,assignment:input.assignment,state:"preparing",remoteConversationId:null,remoteTurnId:null,lastSequence:0,resultText:null,wait:null,error:null,createdAt:stamp,updatedAt:stamp,account:access.account,revision:0,creationKey,payloadHash,request:{modelId:input.modelId,reasoningEffort:input.reasoningEffort,attachments:input.attachments},events:[],outputs:[],cancelRequested:false,completionReceiptId:null,deliveryError:null});
   return serial.run(`job:${job.id}`,async()=>project(await advance(await currentJob(job.id))));
  }),
  detail:(id:string)=>serial.run(`job:${id}`,async():Promise<PonderHostedAssignmentDetail>=>{let job=await currentJob(id);await authorized(job);job=await advance(job);return {assignment:project(job),events:readableEvents(job.events),outputs:job.outputs};}),
  cancel:(id:string)=>serial.run(`job:${id}`,async()=>{let job=await currentJob(id);await authorized(job);if(!["completed","failed","cancelled"].includes(job.state))job=await persist(job,{cancelRequested:true});job=await advance(job);return {assignment:project(job),events:readableEvents(job.events),outputs:job.outputs};}),
 };
}
