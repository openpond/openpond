import { isManagedLocalChatProvider } from "./managed-chat-provider.js";
import { nativeToolTransportEnabledForProvider, resolveHostedToolRolloutFlags } from "../runtime/hosted-turn/rollout.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { TaskSerialExecutor } from "@openpond/agent-runtime/task-signals";
import { ChatModelRefSchema } from "@openpond/contracts/providers";
import type { ProviderSettings, Session } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";

export function createLocalPonderService(deps: {
  hosted?:ReturnType<typeof import("./ponder-hosted-service.js").createPonderHostedService>;
  store: SqliteStore; createSession(payload: unknown): Promise<Session>;
  createReservedSession: ReturnType<typeof import("../store/session-store.js").createSessionStore>["createReservedSession"];
  notifyControl?(relationship: import("./local-ponder-contract.js").LocalPonderRelationship): Promise<void>;
  providerSettings(): Promise<ProviderSettings>; appendRuntimeEvent(runtimeEvent: ReturnType<typeof event>): Promise<void>;
}) {
  const serial = new TaskSerialExecutor();
  const capabilities = {
    remoteAccess: {available:false,reason:"Desktop-owned Pal remote access is not connected yet."},
    hostedSandboxes: {available:Boolean(deps.hosted),reason:deps.hosted?null:"Hosted sandbox delegation is not connected yet."},
    hostedCoordinator: {available:false,reason:"Explicit conversation transfer is not connected yet."},
  };
  async function state() {
    let coordinator = await deps.store.localPonderState();
    if (!coordinator) coordinator = await deps.store.saveLocalPonderState({id:randomUUID(),location:"local",sessionId:null,modelRef:null,revision:1,
      remoteAccessEnabled:false,hostedSandboxesEnabled:false,hostedActivation:"inactive"});
    return coordinator;
  }
  function supportedModelRefs(settings:ProviderSettings) {
    const flags=resolveHostedToolRolloutFlags();
    return Object.values(settings.statuses).filter(status=>status.available&&status.enabled&&(status.id === "openpond" || isManagedLocalChatProvider(status.id))&&status.capabilities.toolCalling&&nativeToolTransportEnabledForProvider(flags,status.id))
      .flatMap(status=>(settings.modelCaches[status.id]?.models ?? []).filter(model=>model.capabilities.toolCalling).map(model=>({providerId:status.id,modelId:model.id})));
  }
  async function readSnapshot() {
    const coordinator = await state();
    const session = coordinator.sessionId ? await deps.store.getSession(coordinator.sessionId) : null;
    return {coordinator,session,capabilities,supportedModelRefs:[] as ReturnType<typeof supportedModelRefs>};
  }
  async function read() {
    const settings=await deps.providerSettings();
    return {...await readSnapshot(),supportedModelRefs:supportedModelRefs(settings)};
  }
  async function agents() {
    const coordinator = await state();
    const items = [];
    const approvals=await deps.store.pendingApprovals();
    for (const relationship of await deps.store.localPonderAgents()) {
      if (relationship.coordinatorId !== coordinator.id) continue;
      const session = await deps.store.getSession(relationship.sessionId);
      if (!session) continue;
      const latestTurn = (await deps.store.turnsForSession(session.id,1))[0] ?? null;
      const [inbox,activity]=await Promise.all([deps.store.taskInboxSnapshot(session.id),deps.store.latestLocalPonderActivity(session.id)]);
      const status=approvals.some(approval=>approval.sessionId===session.id) ? "waiting_approval" : inbox.paused ? "paused"
        : inbox.waits.length ? "waiting" : latestTurn?.status === "in_progress" ? "working" : latestTurn?.status === "failed" ? "failed"
        : latestTurn?.status === "interrupted" ? "interrupted" : inbox.inputs.some(input=>input.state === "pending"&&input.kind === "followup") ? "queued" : latestTurn ? "completed" : "idle";
      items.push({...relationship,session,latestTurn,status,latestActivity:(activity?.output ?? activity?.action ?? activity?.error ?? latestTurn?.error)?.slice(0,500) ?? null});
    }
    return {items};
  }
  return {
    hosted:deps.hosted,
    // Catalogue refresh may query provider endpoints; it must not hold the local
    // session lock or delay transcript rendering while the provider is offline.
    read: async () => {
      const settings=await deps.providerSettings();
      return serial.run("coordinator",async()=>({...await readSnapshot(),supportedModelRefs:supportedModelRefs(settings)}));
    },
    readSnapshot: () => serial.run("coordinator",readSnapshot), agents,
    configure: (payload:unknown) => serial.run("coordinator",async () => {
      const input = z.object({modelRef:ChatModelRefSchema}).strict().parse(payload);
      const coordinator = await state();
      const settings = await deps.providerSettings();
      if(!supportedModelRefs(settings).some(model=>model.providerId===input.modelRef.providerId&&model.modelId===input.modelRef.modelId))
        throw new Error("local_ponder_model_unavailable");
      const existing = coordinator.sessionId ? await deps.store.getSession(coordinator.sessionId) : null;
      if (existing) {
        if (JSON.stringify(coordinator.modelRef) === JSON.stringify(input.modelRef)) return read();
        const {session:updated}=await deps.store.configureLocalPonderModel(input.modelRef,coordinator.revision);
        await deps.appendRuntimeEvent(event({sessionId:updated.id,name:"session.updated",source:"server",data:{session:updated}}));
        return read();
      }
      if(coordinator.modelRef && JSON.stringify(coordinator.modelRef)!==JSON.stringify(input.modelRef)) throw new Error("local_ponder_setup_pending");
      const sessionId=coordinator.sessionId ?? `ponder-${coordinator.id}`;
      // Persist the identity before creation. A crash retries the exact reserved session.
      await deps.store.saveLocalPonderState({...coordinator,sessionId,modelRef:input.modelRef});
      const creationPayload={experience:"work",provider:input.modelRef.providerId,modelRef:input.modelRef,
        systemKind:"openpond.ponder",hiddenFromDefaultSidebar:true,title:"Pal",currentProfile:null,
        metadata:{localPonderCoordinatorId:coordinator.id},cwd:null};
      await deps.createReservedSession(creationPayload,{sessionId,operationId:`local-ponder:${coordinator.id}`,
        payloadHash:createHash("sha256").update(JSON.stringify(creationPayload)).digest("hex")});
      await deps.store.saveLocalPonderState({...coordinator,sessionId,modelRef:input.modelRef,revision:coordinator.revision+1});
      return read();
    }),
    control: (sessionId:string,payload:unknown) => serial.run(`agent:${sessionId}`,async () => {
      const input = z.object({owner:z.enum(["user","ponder"]),revision:z.number().int().positive()}).strict().parse(payload);
      const {relationship,session} = await deps.store.controlLocalPonderAgent(sessionId,input.owner,input.revision);
      if (session) await deps.appendRuntimeEvent(event({sessionId,name:"session.updated",source:"server",data:{session}}));
      await deps.appendRuntimeEvent(event({sessionId:relationship.coordinatorSessionId,name:"diagnostic",source:"server",status:"completed",
        output:input.owner === "user" ? `The user took control of ${session?.title ?? sessionId}. Autonomous instructions are blocked.` : `The user returned ${session?.title ?? sessionId} to Pal. Inspect its latest state before assigning more work.`,data:{localPonderControl:relationship}}));
      try { await deps.notifyControl?.(relationship); }
      catch(error) {
        // The ownership transaction has committed; a notification failure must not imply rollback.
        await deps.appendRuntimeEvent(event({sessionId:relationship.coordinatorSessionId,name:"diagnostic",source:"server",status:"failed",
          output:`Control changed, but its inbox notice could not be delivered: ${String(error)}`,data:{localPonderControl:relationship}}));
      }
      const item = (await agents()).items.find(item => item.sessionId === sessionId);
      return item;
    }),
  };
}
