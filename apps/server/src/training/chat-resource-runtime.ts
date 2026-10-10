import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ChatResourceSummarySchema, type RuntimeEvent, type ChatResourceSummary } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { LocalInferenceState } from "../evaluations/local-experiment-local-inference.js";
import type { ChatResourceAction } from "../openpond/chat-resource-tool-definitions.js";
import {createChatDatasetSourceAction} from "./chat-dataset-sources.js";
import { createLocalDatasetService, localDatasetSummary } from "./local-dataset-service.js";
import { createLocalDatasetSync } from "./local-dataset-sync.js";
import {createChatCloudExperiments,type ChatExperimentView} from "../evaluations/chat-cloud-experiments.js";
import { createChatExperiments } from "../evaluations/chat-experiments.js";
import type { createDatasetImportService } from "./dataset-imports/import-service.js";
import type { HtmlVisualService } from "../visuals/visual-service.js";
import { chatExperimentReport } from "../evaluations/chat-experiment-report.js";

export async function createChatResourceRuntime(deps:{store:SqliteStore;home:string;ownerId:string;state:LocalInferenceState;
  codexStatus?:()=>Promise<import("@openpond/contracts").CodexStatus>;
  access:Parameters<typeof createLocalDatasetSync>[0]["access"];append:(event:RuntimeEvent)=>Promise<void>;
  imports:ReturnType<typeof createDatasetImportService>;
  visuals:HtmlVisualService;
  improve?:(request:unknown)=>Promise<unknown>;
}) {
  const sync = createLocalDatasetSync({store:deps.store,access:deps.access});
  const datasets = createLocalDatasetService({store:deps.store,home:deps.home,syncAction:sync.action,onSaved:sync.onSaved,
    sourceAction:createChatDatasetSourceAction({store:deps.store,imports:deps.imports,create:input=>datasets.request(input)})});
  let experiments:Awaited<ReturnType<typeof createChatExperiments>>;
  try { experiments = await createChatExperiments({store:deps.store,home:deps.home,ownerId:deps.ownerId,state:deps.state,datasets,codexStatus:deps.codexStatus,hosted:{access:deps.access}}); } catch(error) {await sync.close();throw error;}
  const cloud=createChatCloudExperiments({store:deps.store,datasets,access:deps.access});
  async function dispatch(kind:"dataset"|"experiment",input:unknown,signal?:AbortSignal):Promise<unknown> {
    if(kind==="dataset")return datasets.request(input,signal);
    const envelope=z.object({action:z.string(),payload:z.record(z.string(),z.unknown()).default({})}).strict().parse(input);
    if(envelope.action==="run_cloud")return cloud.run(envelope.payload);
    if(envelope.action==="list") {const local=await experiments.request(envelope) as {items:unknown[];summaries:ChatResourceSummary[]};return {...local,summaries:[...local.summaries,...await cloud.list()]};}
    if(envelope.action==="compare") {
      const a=typeof envelope.payload.baselineId==="string" && await deps.store.readChatHostedExperiment(envelope.payload.baselineId),b=typeof envelope.payload.candidateId==="string" && await deps.store.readChatHostedExperiment(envelope.payload.candidateId);
      if(Boolean(a)!==Boolean(b))throw new Error("Local and cloud execution have different owners. Publish a descriptive HTML chart to inspect both instead of a matched comparison.");
      if(a && b)return cloud.compare(envelope.payload);
    }
    if(typeof envelope.payload.id==="string" && await deps.store.readChatHostedExperiment(envelope.payload.id))return cloud.request(envelope.action,envelope.payload);
    return experiments.request(envelope);
  }
  async function wait(id:string){if(await deps.store.readChatHostedExperiment(id))return cloud.wait(id);await experiments.service.wait(id);return dispatch("experiment",{action:"result",payload:{id}});}
  async function emit(sessionId:string,turnId:string,summary:ChatResourceSummary) {
    await deps.store.linkChatResource(sessionId,turnId,summary);
    await deps.append({id:randomUUID(),name:"workspace_action_result",source:"server",sessionId,turnId,timestamp:new Date().toISOString(),action:"chat_resource",status:"completed",data:{chatResource:summary}});
  }
  async function charts(context:{sessionId:string;turnId:string},raw:unknown) {
    const input=z.object({ids:z.array(z.string().min(1)).min(1).max(8),operationId:z.string().min(1).max(200)}).strict().parse(raw);
    if(new Set(input.ids).size!==input.ids.length)throw new Error("Select each retained Experiment once.");
    const session=await deps.store.getSession(context.sessionId);
    if(!session || session.systemKind || session.workspaceKind==="sandbox")throw new Error("The chart conversation is unavailable.");
    const runs=await Promise.all(input.ids.map(async id=>{
      const result=await dispatch("experiment",{action:"result",payload:{id}}) as {summary:ChatResourceSummary;view:ChatExperimentView};
      return {view:result.view,summary:result.summary};
    }));
    const execution={session,turnId:context.turnId,callId:"experiment-chart-"+input.operationId,signal:new AbortController().signal};
    const preview=await deps.visuals.preview(execution,{html:chatExperimentReport(runs)});
    return {visual:await deps.visuals.render(execution,{previewId:preview.previewId,title:"Experiment results"})};
  }
  async function request(kind:"dataset"|"experiment",raw:unknown) {
    const envelope = z.object({context:z.object({sessionId:z.string().min(1),turnId:z.string().min(1)}).optional()}).passthrough().parse(raw);
    const {context,...input} = envelope;
    if(kind==="dataset" && input.action==="resource_index") {
      const links=await deps.store.chatResourceLinks({});
      const unique=new Map<string,ChatResourceSummary>();
      for(const link of links)unique.set(link.summary.kind+":"+link.summary.id,link.summary);
      for(const record of await deps.store.listLocalDatasets())unique.set("dataset:"+record.workspace.draft.id,localDatasetSummary(record));
      return {resources:[...unique.values()],links:links.map(link=>({sessionId:link.sessionId,key:link.summary.kind+":"+link.summary.id}))};
    }
    if (kind === "dataset" && (input.action === "context" || input.action === "set_focus")) {
      const query = z.object({sessionId:z.string().min(1),kind:z.enum(["dataset","experiment"]).optional(),id:z.string().nullable().optional(),revision:z.number().int().positive().optional()}).parse(input.payload);
      const session = await deps.store.getSession(query.sessionId);
      if (!session || session.systemKind || session.workspaceKind === "sandbox") throw new Error("This conversation cannot use installation-local resource focus.");
      const datasetChoices = (await deps.store.listLocalDatasets()).map(localDatasetSummary);
      const page = await experiments.service.list({teamId:experiments.scope}) as {items:import("@openpond/contracts").LocalExperimentRecord[]};
      const localChoices = await Promise.all(page.items.map(record=>experiments.summary(record)));
      const experimentChoices=[...localChoices,...await cloud.list()];
      const focusSchema = z.object({dataset:ChatResourceSummarySchema.nullable(),experiment:ChatResourceSummarySchema.nullable()});
      let focus = focusSchema.safeParse(session.metadata?.chatResourceFocus).success ? focusSchema.parse(session.metadata?.chatResourceFocus) : {dataset:null,experiment:null};
      if (input.action === "context") {
        if(focus.experiment?.location==="local") {
          const record=await deps.store.readLocalExperimentRecord(experiments.scope,focus.experiment.id);
          focus={...focus,experiment:record ? await experiments.summary(record) : null};
        }
        if(focus.dataset) {const pinned=await deps.store.readLocalDataset(focus.dataset.id,focus.dataset.revision);focus={...focus,dataset:pinned ? localDatasetSummary(pinned) : null};}
        return {focus,datasets:datasetChoices,experiments:experimentChoices};
      }
      if (!query.kind) throw new Error("Select the resource focus kind.");
      if (query.kind === "dataset") {
        const dataset = query.id ? localDatasetSummary(await datasets.read(query.id,query.revision)) : null;
        if (query.id && !dataset) throw new Error("Local Dataset was not found.");
        focus = {dataset:dataset ?? null,experiment:dataset && focus.experiment && focus.experiment.datasetId === dataset.id && focus.experiment.datasetRevision === dataset.revision ? focus.experiment : null};
      } else {
        const experiment = query.id ? experimentChoices.find(e=>e.id === query.id) : null;
        if (query.id && !experiment) throw new Error("Local Experiment was not found.");
        const pinned = experiment?.datasetId ? await deps.store.readLocalDataset(experiment.datasetId,experiment.datasetRevision) : null;
        focus = {experiment:experiment ?? null,dataset:pinned ? localDatasetSummary(pinned) : null};
      }
      await deps.store.updateSession(session.id,current=>({...current,metadata:{...current.metadata,chatResourceFocus:focus}}));
      return focus;
    }
    if (context) {
      const [session,turn] = await Promise.all([deps.store.getSession(context.sessionId),deps.store.getTurn(context.turnId)]);
      if (!session || session.systemKind || session.workspaceKind === "sandbox" || turn?.sessionId !== session.id) throw new Error("Resource action belongs to an unavailable conversation response.");
    }
    if(kind==="experiment" && input.action==="improve") {
      if(!deps.improve)throw new Error("The qualified Improve owner is unavailable.");
      return deps.improve(input.payload);
    }
    if(kind==="experiment" && input.action==="charts") {
      if(!context)throw new Error("HTML charts require a conversation response; retained results remain available through result.");
      return charts(context,input.payload);
    }
    const result = await dispatch(kind,input);
    if (context && result && typeof result === "object") {
      const object = result as Record<string,unknown>;
      const summaries = [object.summary,...Array.isArray(object.summaries) ? object.summaries : []].map(value=>ChatResourceSummarySchema.safeParse(value)).filter(value=>value.success).map(value=>value.data);
      for (const summary of summaries) await emit(context.sessionId,context.turnId,summary);
      if (kind === "experiment" && typeof input.action === "string" && ["run","run_cloud"].includes(input.action)) for (const summary of summaries) void wait(summary.id).then(async result=> {
        const updated = result as {summary:ChatResourceSummary};
        await emit(context.sessionId,context.turnId,{...updated.summary,datasetId:summary.datasetId,datasetRevision:summary.datasetRevision});
      }).catch(()=>{});
    }
    return result;
  }
  const execute:ChatResourceAction = async(context,kind,payload)=> {
    const action = payload.action;
    if(kind==="experiment" && action==="improve") {
      if(!deps.improve)throw new Error("The qualified Improve owner is unavailable.");
      return deps.improve(payload.payload);
    }
    if(kind==="experiment" && action==="charts")return charts({sessionId:context.session.id,turnId:context.turnId},payload.payload);
    let authorOperationId:string | undefined;
    if (kind === "dataset" && ["create","import","import_source"].includes(String(action))) {
      const ownerId = await deps.store.localResourceOwnerId();
      const details = payload.payload as Record<string,unknown> | undefined;
      const operationId = action === "import_source" && typeof details?.operationId === "string" ? details.operationId : typeof payload.operationId === "string" ? payload.operationId : context.callId;
      authorOperationId=operationId;
      payload = action === "import_source" ? {...payload,payload:{...details,operationId}} : {...payload,operationId};
      const scaffold:ChatResourceSummary = {kind:"dataset",id:`dataset-${contentHash([ownerId,operationId]).slice(0,40)}`,revision:1,name:typeof details?.name === "string" ? details.name : "New dataset",state:action === "create" ? "Creating" : "Importing",taskCount:0,graderCount:0,rows:[]};
      await emit(context.session.id,context.turnId,scaffold);
    }
    let result:unknown;
    try { result = await dispatch(kind,payload,context.signal); }
    catch (error) {
      if (kind === "dataset" && authorOperationId) {
        const ownerId = await deps.store.localResourceOwnerId();
        const id = `dataset-${contentHash([ownerId,authorOperationId]).slice(0,40)}`;
        const saved = await deps.store.readLocalDataset(id);
        await emit(context.session.id,context.turnId,saved ? localDatasetSummary(saved) : {kind:"dataset",id,revision:1,name:"New dataset",state:context.signal.aborted ? "Cancelled" : "Failed",taskCount:0,graderCount:0,rows:[]});
      }
      throw error;
    }
    const object = result && typeof result === "object" ? result as Record<string,unknown> : {};
    const summaries = [object.summary,...(Array.isArray(object.summaries) ? object.summaries : [])].map(value=>ChatResourceSummarySchema.safeParse(value)).filter(value=>value.success).map(value=>value.data);
    for (const summary of summaries) await emit(context.session.id,context.turnId,summary);
    if (kind === "experiment" && typeof action === "string" && ["run","run_cloud"].includes(action)) {
      for (const summary of summaries) void wait(summary.id).then(async result=> {
        const updated = result as {summary:ChatResourceSummary};
        await emit(context.session.id,context.turnId,{...updated.summary,datasetId:summary.datasetId,datasetRevision:summary.datasetRevision});
      }).catch(() => {});
    }
    return result;
  };
  return {datasets,experiments,request,execute,close:async()=>{cloud.close();await sync.close();await experiments.service.close();}};
}
