import { z } from 'zod';
import type {SqliteStore} from '../store/store.js';
const Entry=z.object({kind:z.enum(['training','experiment']),id:z.string().min(1),name:z.string(),phase:z.string(),href:z.string(),updatedAt:z.iso.datetime()}).strict();
export const HostedExecutionActivitySchema=z.object({scope:z.object({teamId:z.string().min(1),projectId:z.string().nullable()}).strict(),generatedAt:z.iso.datetime(),counts:z.object({training:z.number().int().nonnegative(),experiments:z.number().int().nonnegative()}).strict(),items:z.array(Entry).max(300),hasMore:z.boolean()}).strict();
export type ExecutionActivityResponse={scopeKey:string;generatedAt:string;counts:{training:number;experiments:number};items:Array<{kind:'training'|'experiment';location:'hosted'|'local';id:string;name:string;phase:string;updatedAt:string;href?:string}>;hasMore:boolean};
export function executionActivityScopeKey(teamId:string,actorId:string,projectId:string|null){return JSON.stringify([teamId,actorId,projectId]);}
/** Authenticate both before and after I/O so switching accounts cannot publish
 * an old account's queue into the currently visible header. Reads start no work. */
export function createExecutionActivityService(deps:{store:Pick<SqliteStore,"readExecutionActivity"|"readTrainingExecutionActivity">;teamId:()=>Promise<string>;actorId:()=>Promise<string>;authorizeProject:(teamId:string,actorId:string,projectId:string)=>Promise<void>;hosted:(teamId:string,projectId:string|null)=>Promise<unknown>}) {
  return async function read(raw:unknown):Promise<ExecutionActivityResponse>{
    const input=z.object({teamId:z.string().min(1),projectId:z.string().nullable()}).strict().parse(raw),actorId=await deps.actorId();
    if(!actorId.trim()||await deps.teamId()!==input.teamId)throw new Error('Activity workspace is unavailable to this account.');
    if(input.projectId)await deps.authorizeProject(input.teamId,actorId,input.projectId);
    const [local,localTraining,rawHosted]=await Promise.all([deps.store.readExecutionActivity({...input,actorId}),deps.store.readTrainingExecutionActivity({...input,actorId}),deps.hosted(input.teamId,input.projectId)]);
    const hosted=HostedExecutionActivitySchema.parse(rawHosted);
    if(hosted.scope.teamId!==input.teamId||hosted.scope.projectId!==input.projectId)throw new Error('Activity response belongs to another scope.');
    if(await deps.actorId()!==actorId||await deps.teamId()!==input.teamId)throw new Error('Activity account changed during refresh.');
    const items=[...local.items,...localTraining.items,...hosted.items.map(item=>({...item,location:'hosted' as const}))].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    if(new Set(items.map(item=>JSON.stringify([item.kind,item.location,item.id]))).size!==items.length)throw new Error('Activity response contains duplicate executions.');
    return {scopeKey:executionActivityScopeKey(input.teamId,actorId,input.projectId),generatedAt:hosted.generatedAt,counts:{training:hosted.counts.training+localTraining.count,experiments:hosted.counts.experiments+local.count},items:items.slice(0,100),hasMore:hosted.hasMore||items.length>100||local.count>local.items.length||localTraining.count>localTraining.items.length};
  };
}
