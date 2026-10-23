import { z } from "zod";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProviderSettings, Session, TaskInput } from "@openpond/contracts";
import { ChatModelRefSchema } from "@openpond/contracts/providers";
import type { TaskInboxRepository } from "../runtime/task-inbox/repository.js";
import type { TaskInboxRuntime } from "../runtime/task-inbox/runtime.js";
import type { ModelToolDefinition, ModelToolExecutionContext } from "./model-tool-registry.js";
import { TaskSerialExecutor } from "@openpond/agent-runtime/task-signals";

const StartSchema = z.object({title:z.string().trim().min(1).max(200),assignment:z.string().trim().min(1).max(48_000),
  modelRef:ChatModelRefSchema,cwd:z.string().min(1),localProjectId:z.string().optional()}).strict();
export function localPonderTools(deps:{store:TaskInboxRepository;inbox:TaskInboxRuntime;createSession?:(payload:unknown)=>Promise<Session>;
  createReservedSession?:ReturnType<typeof import("../store/session-store.js").createSessionStore>["createReservedSession"];
  projects?:()=>Promise<Array<{id:string;name:string;workspacePath:string}>>;
  settings?:()=>Promise<ProviderSettings>;getSession(id:string):Promise<Session>;sessions():Promise<Session[]>;
  transcript(sessionId:string,beforeSequence?:number):Promise<unknown>;stop(sessionId:string):Promise<unknown>;
}):ModelToolDefinition[] {
  const serial = new TaskSerialExecutor();
  function tool(name:string,description:string,schema:z.ZodType,execute:(context:ModelToolExecutionContext)=>Promise<unknown>):ModelToolDefinition {
    return {name,description,parameters:z.toJSONSchema(schema),enabled:({session})=>session.systemKind === "openpond.ponder",
      execute:async context => { if(context.session.systemKind !== "openpond.ponder") throw new Error("local_ponder_required");
        const data=await execute(context);return {toolCallId:context.callId,name,ok:true,contentText:JSON.stringify(data),data}; }};
  }
  async function target(context:ModelToolExecutionContext,id:string) {
    const coordinator = await deps.store.localPonderState?.();
    const relationship = (await deps.store.localPonderAgents?.())?.find(agent=>agent.sessionId === id && agent.coordinatorId === coordinator?.id);
    if(!relationship || relationship.coordinatorSessionId !== context.session.id) throw new Error("local_ponder_agent_not_found");
    return relationship;
  }
  return [
    tool("openpond_discover_agents","Discover configured local worker models and existing authorized project folders. Select only available configured models; native Codex and Claude Code keep their own context.",z.object({}).strict(),async ()=>{
      const settings=await deps.settings?.();
      return {providers:Object.values(settings?.statuses ?? {}).filter(status=>status.available&&status.enabled&&status.routing.localRuntime).map(status=>({id:status.id,defaultModel:status.defaultModel,models:settings?.modelCaches[status.id]?.models.map(model=>({id:model.id,toolCalling:model.capabilities.toolCalling})) ?? []})),
        projects:(await deps.projects?.() ?? []).map(project=>({cwd:project.workspacePath,localProjectId:project.id,title:project.name}))};
    }),
    tool("openpond_start_agent","Start one persistent local worker with a bounded assignment, configured model and explicit local project folder. Returns the same session and exact input receipt on retries; wait using its inputId. Do not repeat launch when status is uncertain.",StartSchema,async context=>serial.run(`start:${context.turnId}:${context.callId}`,async()=>{
      const input=StartSchema.parse(context.args);
      const coordinator=await deps.store.localPonderState?.();
      if(!coordinator||coordinator.sessionId!==context.session.id||!deps.createReservedSession||!deps.store.registerLocalPonderAgent) throw new Error("local_ponder_unavailable");
      const creationKey=`${context.turnId}:${context.callId}`;
      const previous=(await deps.store.localPonderAgents?.())?.find(agent=>agent.creationKey===creationKey);
      let session:Session;
      if(previous) session=await deps.getSession(previous.sessionId);
      else {
        const settings=await deps.settings?.();const status=settings?.statuses[input.modelRef.providerId];
        if(!status?.available||!status.enabled||!status.routing.localRuntime||!(settings?.modelCaches[input.modelRef.providerId]?.models.some(model=>model.id===input.modelRef.modelId)||status.modelIds.includes(input.modelRef.modelId))) throw new Error("local_ponder_worker_model_unavailable");
        if(!path.isAbsolute(input.cwd)) throw new Error("local_ponder_absolute_project_required");
        // Only folders already exposed to the coordinator may be used; model text cannot grant project access.
        const projects=await deps.projects?.() ?? [];
        const project=projects.find(project=>project.workspacePath===input.cwd&&(!input.localProjectId||input.localProjectId===project.id));
        if(!project) throw new Error("local_ponder_project_not_authorized");
        const payload={experience:"work",provider:input.modelRef.providerId,modelRef:input.modelRef,
          title:input.title,cwd:input.cwd,localProjectId:project.id,parentSessionId:context.session.id,parentTurnId:context.turnId,
          hiddenFromDefaultSidebar:true,currentProfile:null,metadata:{localPonderCoordinatorId:coordinator.id,localPonderCreationKey:creationKey}};
        const hash=createHash("sha256").update(creationKey).digest("hex");
        session=await deps.createReservedSession(payload,{sessionId:`ponder-agent-${hash}`,operationId:`local-ponder-agent:${creationKey}`,
          payloadHash:createHash("sha256").update(JSON.stringify(payload)).digest("hex")});
        const timestamp=new Date().toISOString();
        await deps.store.registerLocalPonderAgent({sessionId:session.id,coordinatorId:coordinator.id,coordinatorSessionId:context.session.id,
          owner:"ponder",revision:1,assignment:input.assignment,creationKey,createdAt:timestamp,updatedAt:timestamp});
      }
      const receipt:TaskInput=await deps.inbox.send({senderSessionId:context.session.id,sessionId:session.id,kind:"followup",body:input.assignment,
        executionPermissions:context.turnPermissions,
        idempotencyKey:`local-ponder:${createHash("sha256").update(creationKey).digest("hex")}`});
      return {sessionId:session.id,inputId:receipt.id,receipt};
    })),
    tool("openpond_inspect_agent","Read the retained transcript and actual execution state of an associated worker without changing control ownership or consuming its inbox. Returns the newest event page; pass nextBeforeSequence to read earlier retained evidence.",z.object({taskId:z.string(),beforeSequence:z.number().int().positive().optional()}).strict(),async context=>{
      const {taskId,beforeSequence}=z.object({taskId:z.string(),beforeSequence:z.number().int().positive().optional()}).parse(context.args);const relationship=await target(context,taskId);
      return {relationship,session:await deps.getSession(taskId),transcript:await deps.transcript(taskId,beforeSequence)};
    }),
    tool("openpond_stop_agent","Stop an associated Pal-controlled worker. User-controlled workers require the user to stop them directly.",z.object({taskId:z.string()}).strict(),async context=>{
      const {taskId}=z.object({taskId:z.string()}).parse(context.args);const relationship=await target(context,taskId);
      if(relationship.owner!=="ponder") throw new Error("local_ponder_control_changed");
      // This is the stop admission boundary. Takeover after admission cannot undo it.
      await deps.store.assertLocalPonderInput?.({sessionId:taskId,senderSessionId:context.session.id,payload:{localPonderControlRevision:relationship.revision}});
      return deps.stop(taskId);
    }),
  ];
}
