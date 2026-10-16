import {createHash} from "node:crypto";
import {realpath,open,stat} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {z} from "zod";
import type {HostedPonderAccess} from "./ponder-hosted-access.js";
import type {SqliteStore} from "../store/store.js";
export const HostedInputSchema=z.object({requestId:z.string().min(1).max(200),projectId:z.string().min(1),relativePath:z.string().min(1).max(1000),contentType:z.string().min(1).max(200)}).strict();
export type HostedPonderInput={creationKey:string;payloadHash:string;account:HostedPonderAccess["account"];descriptor:{id:string;name:string;contentType:string;sizeBytes:number}|null;completed:boolean};
export async function stagePonderHostedInput(deps:{store:SqliteStore;access:HostedPonderAccess;coordinatorId:string;projects:()=>Promise<{id:string;workspacePath:string}[]>},payload:unknown){
 const input=HostedInputSchema.parse(payload);const project=(await deps.projects()).find(project=>project.id===input.projectId);if(!project)throw new Error("local_ponder_project_not_authorized");
 if(path.isAbsolute(input.relativePath))throw new Error("local_ponder_hosted_relative_asset_required");
 const root=await realpath(project.workspacePath),file=await realpath(path.resolve(root,input.relativePath));const relative=path.relative(root,file);
 if(!relative||relative.startsWith(`..${path.sep}`)||relative===".."||path.isAbsolute(relative))throw new Error("local_ponder_hosted_asset_outside_project");
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes:Buffer;
 try{const info=await handle.stat();if(!info.isFile()||info.size>10000000)throw new Error("local_ponder_hosted_asset_size_invalid");
 const verified=await realpath(file),checked=await stat(verified),verifiedRelative=path.relative(root,verified);
 if(verifiedRelative===".."||verifiedRelative.startsWith(`..${path.sep}`)||path.isAbsolute(verifiedRelative)||checked.ino!==info.ino||checked.dev!==info.dev)throw new Error("local_ponder_hosted_asset_outside_project");
 const buffer=Buffer.alloc(info.size+1);const read=await handle.read(buffer,0,buffer.length,0);bytes=buffer.subarray(0,read.bytesRead);const after=await handle.stat();if(bytes.length!==info.size||after.mtimeMs!==info.mtimeMs||after.size!==info.size)throw new Error("local_ponder_hosted_asset_changed");
 }finally{await handle.close();}
 const descriptor={name:path.basename(file),contentType:input.contentType,sizeBytes:bytes.length,sha256Base64:createHash("sha256").update(bytes).digest("base64")};
 const creationKey=`${deps.coordinatorId}:${input.requestId}`;const payloadHash=createHash("sha256").update(JSON.stringify({input,descriptor,account:deps.access.account})).digest("hex");
 let retained=await deps.store.reserveHostedPonderInput({creationKey,payloadHash,account:deps.access.account,descriptor:null,completed:false});
 if(retained.completed&&retained.descriptor)return retained.descriptor;
 const plan=z.object({input:z.object({id:z.string(),name:z.string(),contentType:z.string(),sizeBytes:z.number()}),upload:z.object({url:z.string().url(),method:z.literal("PUT"),headers:z.record(z.string(),z.string())})}).parse(await deps.access.client.request({path:"/work-inputs",method:"POST",idempotencyKey:`local-ponder-input:${createHash("sha256").update(creationKey).digest("hex")}`,body:descriptor}));
 if(plan.input.name!==descriptor.name||plan.input.contentType!==descriptor.contentType||plan.input.sizeBytes!==descriptor.sizeBytes)throw new Error("local_ponder_hosted_asset_descriptor_changed");
 retained=await deps.store.saveHostedPonderInput({...retained,descriptor:plan.input});
 const uploaded=await fetch(plan.upload.url,{method:plan.upload.method,headers:plan.upload.headers,body:new Uint8Array(bytes).buffer,redirect:"error",signal:AbortSignal.timeout(60000)});if(!uploaded.ok)throw new Error("local_ponder_hosted_asset_upload_failed");
 const finalized=await deps.access.client.request({path:`/work-inputs/${encodeURIComponent(plan.input.id)}/finalize`,method:"POST"});
 const result=z.object({id:z.string(),name:z.string(),contentType:z.string(),sizeBytes:z.number()}).parse(finalized);
 if(result.id!==plan.input.id||result.name!==descriptor.name||result.contentType!==descriptor.contentType||result.sizeBytes!==descriptor.sizeBytes)throw new Error("local_ponder_hosted_asset_descriptor_changed");
 await deps.store.saveHostedPonderInput({...retained,descriptor:result,completed:true});return result;
}
