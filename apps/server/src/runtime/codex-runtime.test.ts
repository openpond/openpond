import {expect,test,vi} from "vitest";
import {SessionSchema} from "@openpond/contracts";
import {createBackgroundWorkerQueue} from "./background-worker-queue.js";
import {createCodexRuntimeManager} from "./codex-runtime.js";

const provider=vi.hoisted(()=>({notify:null as null|((notification:{method:string;params?:unknown})=>void)}));
vi.mock("@openpond/codex-provider",()=>({CodexAppServerClient:class {
  constructor(options:{onNotification:(notification:{method:string;params?:unknown})=>void}){provider.notify=options.onNotification;}
  async startThread(){return {threadId:"owned-native-thread"};}
  async stop(){}
  async stopAndWait(){}
}}));

// Failure story: the native provider can finish before its queued evidence is
// saved. An evaluation must wait for that evidence and reject a failed write,
// not grade partial text or capture files before the last response is retained.
test("native completion waits for retained evidence and surfaces ingestion failures",async()=>{
  const queue=createBackgroundWorkerQueue({queueId:"native-evidence"});
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const written:string[]=[];
  const session=SessionSchema.parse({id:"owned-case",provider:"codex",experience:"work",title:"Evaluation",appId:null,appName:null,cwd:"/unused",codexThreadId:null,
    createdAt:"2026-10-10T00:00:00.000Z",updatedAt:"2026-10-10T00:00:00.000Z",status:"active",pinned:false,archived:false,order:0,metadata:{profileEvaluationRun:{id:"evaluation"}}});
  const manager=createCodexRuntimeManager({
    appendRuntimeEvent:async()=>{},codexSessions:new Map(),getCodexStatus:()=>({}) as never,
    handleCodexServerRequest:async()=>({result:null}),mapCodexNotification:(_session,notification)=>queue.enqueue({label:notification.method},async()=>{
      if(notification.method==="delta")await blocked;
      if(notification.method==="failed-write")throw new Error("Storage unavailable");
      written.push(notification.method);
    }),setCodexStatus:()=>{},store:{} as never,storeDir:"/unused",
    updateSession:async()=>session,
  });
  try {
    await manager.ensureCodexRuntime(session,
      {codexPermissionMode:"default",approvalPolicy:"on-request",sandbox:"workspace-write"});
    provider.notify!({method:"delta"});provider.notify!({method:"completed"});
    let settled=false;
    const flushing=manager.flushCodexRuntimeEvents("owned-case").then(()=>{settled=true;});
    await Promise.resolve();expect(settled).toBe(false);expect(written).toEqual([]);
    release();await flushing;expect(written).toEqual(["delta","completed"]);
    provider.notify!({method:"failed-write"});
    await expect(manager.flushCodexRuntimeEvents("owned-case")).rejects.toThrow("Storage unavailable");
    const first=await manager.ensureCodexRuntime(session,
      {codexPermissionMode:"default",approvalPolicy:"on-request",sandbox:"workspace-write"});
    await manager.stopCodexRuntime("owned-case");
    const replacement=await manager.ensureCodexRuntime(session,
      {codexPermissionMode:"default",approvalPolicy:"on-request",sandbox:"workspace-write"});
    expect(replacement.client).not.toBe(first.client);
  } finally {await queue.drain();await manager.closeCoordination();}
});
