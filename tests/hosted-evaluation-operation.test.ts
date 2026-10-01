import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import {expect,test} from "vitest";
import {contentHash} from "@openpond/harness";
import {SqliteStore} from "../apps/server/src/store/store.js";
import {createHostedEvaluationWorkspace} from "../apps/server/src/training/hosted-evaluation-workspace.js";
import {createHttpRequestHandler,type HttpRouteDeps} from "../apps/server/src/api/http-routes.js";
import {createWorkspaceApi} from "../apps/web/src/components/labs/workspace/workspace-api.js";

// Failure story: a changed native HTTP origin after restart must not create a
// new Start, while another authenticated actor/workspace cannot recover it.
test("durable evaluation intent survives restart and fences acknowledgement scope",async()=> {
  const home=await mkdtemp(path.join(tmpdir(),"openpond-evaluation-intent-"));
  let store=new SqliteStore(home),actorId="actor-a",teamId="team-a",apiBaseUrl="https://staging.example.test";
  const create=()=>createHostedEvaluationWorkspace({store,resolveActorId:async()=>actorId,
    resolveAccess:async()=>({apiBaseUrl,token:"controlled-test-key",teamId}),
    fetch:async()=>{throw new Error("Operation recovery must not dispatch a hosted job.");}});
  let service=create();
  const intent={name:"One immutable Experiment",dataset:{id:"dataset-one",revision:1,contentHash:"a".repeat(64)}};
  const value={action:"run",intentHash:contentHash(intent)};
  const servers:Server[]=[];
  async function launch() {
    const server=createServer(createHttpRequestHandler({host:"127.0.0.1",getActualPort:()=>(server.address() as AddressInfo).port,
      token:"local-operation-capability",version:"proof",logger:{info(){},warn(){},error(){}},trainingPayload:async(operation:string,payload:unknown)=>{
        if(operation!=="evaluation_workspace")throw new Error("Unexpected runtime operation.");return service.request(payload);
      }} as unknown as HttpRouteDeps));
    servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");
    const serverUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {serverUrl,api:createWorkspaceApi({serverUrl,token:"local-operation-capability",platform:"linux"},{accountKey:"account-proof",teamId,projectId:null})};
  }
  const prepare=()=>service.request({teamId,projectId:null,operation:"prepareOperation",value}) as Promise<{id:string;createdAt:string}>;
  try {
    const [first,concurrent]=await Promise.all([prepare(),prepare()]);expect(concurrent).toEqual(first);
    const original=await launch();expect((await original.api.operation("run",intent)).id).toBe(first.id);
    await store.close();store=new SqliteStore(home);service=create();expect(await prepare()).toEqual(first);
    const restarted=await launch();expect(restarted.serverUrl).not.toBe(original.serverUrl);
    expect((await restarted.api.operation("run",intent)).id).toBe(first.id);
    actorId="actor-b";expect((await prepare()).id).not.toBe(first.id);
    await expect(service.request({teamId,operation:"acknowledgeOperation",value:{...value,id:first.id}})).rejects.toThrow("does not own");
    actorId="actor-a";expect(await prepare()).toEqual(first);
    teamId="team-b";expect((await prepare()).id).not.toBe(first.id);teamId="team-a";
    apiBaseUrl="https://other.example.test";expect((await prepare()).id).not.toBe(first.id);apiBaseUrl="https://staging.example.test";
    expect(await prepare()).toEqual(first);
    expect(await service.request({teamId,operation:"acknowledgeOperation",value:{...value,id:first.id}})).toEqual({acknowledged:true});
    const explicitNext=await prepare();expect(explicitNext.id).not.toBe(first.id);
    await expect(service.request({teamId,operation:"acknowledgeOperation",value:{...value,id:first.id}})).rejects.toThrow("does not own");
    expect(await prepare()).toEqual(explicitNext);
  } finally {await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));await store.close();await rm(home,{recursive:true,force:true});}
});
