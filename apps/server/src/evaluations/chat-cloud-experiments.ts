import {z} from "zod";
import {contentHash} from "@openpond/harness";
import {OpenPondDatasetWorkspaceClient} from "openpond-sdk/dataset-workspaces";
import {OpenPondExperimentsClient,RunExperimentSchema,ExperimentRunDetailsSchema,type ExperimentRunDetails} from "openpond-sdk/experiments";
import type {ExperimentResult} from "@openpond/evals/experiments";
import type {ChatResourceSummary,LocalDatasetRecord,ChatExperimentView} from "@openpond/contracts";
import type {SqliteStore} from "../store/store.js";
import type {createLocalDatasetService} from "../training/local-dataset-service.js";
import {ChatExperimentRun} from "./chat-experiments.js";

const Pin=z.object({actorId:z.string().min(1),teamId:z.string().min(1),apiOrigin:z.url()}).strict();
const Hosted=z.object({pin:Pin,datasetId:z.string().min(1),datasetRevision:z.number().int().positive(),details:ExperimentRunDetailsSchema}).strict();
const Group=z.object({location:z.literal("cloud"),pin:Pin,datasetId:z.string(),datasetRevision:z.number().int().positive(),configurations:z.array(RunExperimentSchema).min(1).max(8)}).strict();
export type {ChatExperimentView} from "@openpond/contracts";

export function cloudExperimentSummary(record:z.infer<typeof Hosted>,result?:ExperimentResult):ChatResourceSummary {
  const details=record.details,summary=details.summary;
  const evaluated=result?.cases.filter(row=>row.status==="completed" && row.feedback.length>0 && row.feedback.every(value=>value.status==="scored")).length ?? 0;
  const quality=result?.cases.filter(row=>row.status==="completed" && row.feedback.some(value=>value.passed===false)).length ?? 0;
  const execution=result?.cases.filter(row=>row.status==="failed" || row.status==="unavailable").length ?? summary.counts.failed;
  const costs=result?.cases.map(row=>row.usage.costUsd);
  return {kind:"experiment",id:summary.id,revision:1,location:"cloud",datasetId:record.datasetId,datasetRevision:record.datasetRevision,name:summary.name ?? summary.id,state:summary.status,
    model:details.request.policy.kind==="fixture" ? "Fixture" : `openpond/${details.request.policy.modelId}`,taskCount:summary.totalCount,evaluatedCount:evaluated,
    score:summary.score,scoreLabel:summary.metricName,costUsd:costs?.length && costs.every(value=>value!==null) ? costs.reduce<number>((sum,value)=>sum+value!,0) : null,
    qualityFailureCount:quality,executionFailureCount:execution,failedCount:quality+execution,ungradedCount:summary.totalCount-evaluated,
    rows:(result?.cases ?? []).slice(0,3).map(row=>({id:contentHash(row.identity).slice(0,40),label:row.identity.caseId,detail:row.error?.message ?? row.feedback.map(value=>`${value.feedbackKey}: ${value.status}${value.value!==null ? ` (${value.value})` : ""}`).join(" · ")}))};
}
export function cloudExperimentView(record:z.infer<typeof Hosted>,result:ExperimentResult):ChatExperimentView {
  return {contentHash:result.contentHash,graders:record.details.configuration.graders,scope:record.details.request.taskset.contentHash,cases:result.cases.map(row=>({id:contentHash(row.identity).slice(0,40),taskId:row.identity.caseId,seed:row.identity.seed,status:row.status,error:row.error?.message ?? null,output:row.output===null ? null : typeof row.output==="string" ? row.output : JSON.stringify(row.output),score:null}))};
}

/** Publication and remote execution use the existing SDK owners. Local intent
 * pins the acknowledged immutable cloud version before any compute dispatch. */
export function createChatCloudExperiments(deps:{store:SqliteStore;datasets:ReturnType<typeof createLocalDatasetService>;access:()=>Promise<{apiBaseUrl:string;token:string;actorId:string;teamId:string}>;fetch?:typeof fetch}) {
  const shutdown=new AbortController();
  const transport:typeof fetch=(url,init)=>(deps.fetch ?? fetch)(url,{...init,signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(30_000),...init?.signal ? [init.signal] : []])});
  async function access(pin?:z.infer<typeof Pin>) {
    const current=await deps.access(),actual=Pin.parse({actorId:current.actorId,teamId:current.teamId,apiOrigin:new URL(current.apiBaseUrl).origin});
    if(pin && contentHash(actual)!==contentHash(pin))throw new Error("Select this Experiment's linked account and workspace before cloud operations.");
    return {...current,pin:actual};
  }
  const client=(current:Awaited<ReturnType<typeof access>>)=>new OpenPondExperimentsClient({baseUrl:current.apiBaseUrl,apiKey:current.token,teamId:current.teamId,fetch:transport});
  async function retain(pin:z.infer<typeof Pin>,datasetId:string,datasetRevision:number,details:ExperimentRunDetails) {
    const record=Hosted.parse({pin,datasetId,datasetRevision,details});await deps.store.retainChatHostedExperiment(details.summary.id,contentHash(pin),details.configuration.configurationHash,record);return record;
  }
  async function read(id:string) {const raw=await deps.store.readChatHostedExperiment(id);if(!raw)throw new Error("This cloud Experiment was not retained by this installation.");return Hosted.parse(raw);}
  async function run(raw:unknown) {
    const input=ChatExperimentRun.parse(raw);
    if(input.models.some(model=>model.providerId!=="openpond") || new Set(input.models.map(model=>model.modelId)).size!==input.models.length)throw new Error("Cloud execution requires distinct available OpenPond models.");
    const owner=await deps.store.localResourceOwnerId(),requestHash=contentHash({owner,location:"cloud",input});
    let saved=await deps.store.readChatExperimentGroup(input.operationId,requestHash);
    if(!saved) {
      const published=await deps.datasets.request({action:"publish",id:input.datasetId,expectedRevision:input.revision}) as {record:LocalDatasetRecord};
      const link=published.record.sync;
      if(!link || link.acknowledgedHash!==published.record.workspace.contentHash || published.record.workspace.draft.revision!==input.revision || link.status!=="synced")throw new Error(link?.error ?? "The exact requested local revision has not been acknowledged and published.");
      const current=await access({actorId:link.actorId,teamId:link.teamId,apiOrigin:link.apiOrigin});
      const remote=await new OpenPondDatasetWorkspaceClient({baseUrl:current.apiBaseUrl,apiKey:current.token,teamId:current.teamId,fetch:transport}).version(link.datasetId,link.remoteRevision);
      if(remote.workspace.contentHash!==link.remoteHash || !remote.publication || contentHash(remote.publication.release)!==contentHash(remote.workspace.draft.publishedTasksetRef))throw new Error("The immutable cloud publication differs from the acknowledged version.");
      const budget=Math.floor(input.maximumCostUsd*1e6/input.models.length)/1e6;if(budget<1e-6)throw new Error("The requested total budget cannot allocate a positive ceiling to every model.");
      const configurations=input.models.map((model,index)=>{
        const operationId=input.operationId+":"+index;
        return RunExperimentSchema.parse({operationId,maximumCostUsd:budget,request:{schemaVersion:"openpond.modelTasksetRunRequest.v1",operationId,teamId:current.teamId,modelProjectId:null,name:published.record.workspace.draft.name+" · "+model.modelId,
          taskset:remote.publication!.release,policy:{kind:"hosted_chat",modelId:model.modelId,maxOutputTokens:input.maxOutputTokens,temperature:0,topP:1},population:remote.workspace.draft.tasks.slice(0,input.taskLimit).map(task=>({receiptId:"case-"+contentHash([operationId,task.id,input.seed]).slice(0,40),taskId:task.id,seed:String(input.seed),fixtureId:null}))}});
      });
      saved=await deps.store.prepareChatExperimentGroup(input.operationId,requestHash,{location:"cloud",pin:current.pin,datasetId:input.datasetId,datasetRevision:input.revision,configurations});
    }
    const group=Group.parse(saved),runs=[],summaries=[],errors=[];
    for(const configuration of group.configurations) {
      try {const current=await access(group.pin);const details=await client(current).run(configuration);const record=await retain(group.pin,group.datasetId,group.datasetRevision,details);runs.push(details);summaries.push(cloudExperimentSummary(record));}
      catch(error){errors.push({modelId:configuration.request.policy.kind==="fixture" ? "Fixture" : configuration.request.policy.modelId,message:error instanceof Error ? error.message : "Cloud admission failed."});}
    }
    if(!runs.length)throw new Error(errors.map(error=>`${error.modelId}: ${error.message}`).join("\n"));
    return {runs,summaries,errors,maximumCostUsd:input.maximumCostUsd};
  }
  async function list(){return (await deps.store.listChatHostedExperiments()).map(raw=>cloudExperimentSummary(Hosted.parse(raw)));}
  async function compare(payload:Record<string,unknown>){const input=z.object({baselineId:z.string().min(1),candidateId:z.string().min(1)}).parse(payload);const [a,b]=await Promise.all([read(input.baselineId),read(input.candidateId)]);if(contentHash(a.pin)!==contentHash(b.pin))throw new Error("Cloud comparison requires the same pinned account and workspace.");return client(await access(a.pin)).compare(input.baselineId,input.candidateId);}
  async function request(action:string,payload:Record<string,unknown>) {
    if(typeof payload.id!=="string")throw new Error("Select a retained cloud Experiment.");
    let record=await read(payload.id);const current=await access(record.pin),api=client(current);
    const details=action==="cancel" ? await api.cancel(payload.id) : await api.get(payload.id);
    record=await retain(record.pin,record.datasetId,record.datasetRevision,details);
    if(action==="case") {
      const receipt=z.object({receiptId:z.string().min(1)}).parse(payload);
      const member=details.request.population.find(row=>row.receiptId===receipt.receiptId);if(!member)throw new Error("This case was not admitted by the cloud Experiment.");
      const evidence=await api.result(payload.id);return {case:evidence.result.cases.find(row=>row.identity.caseId===member.taskId && row.identity.seed===member.seed),diagnostics:await api.diagnostics(payload.id)};
    }
    const evidence=details.summary.resultAvailable ? await api.result(payload.id) : undefined;
    return {result:details,summary:cloudExperimentSummary(record,evidence?.result),evidence,view:evidence ? cloudExperimentView(record,evidence.result) : {cases:[],contentHash:details.manifest.contentHash,graders:details.configuration.graders,scope:details.request.taskset.contentHash}};
  }
  async function wait(id:string) {
    while(!shutdown.signal.aborted) {
      const result=await request("status",{id});if(!("summary" in result) || !result.summary)throw new Error("Cloud status did not return its retained summary.");if(!["queued","running","cancelling"].includes(result.summary.state))return result;
      await new Promise<void>((resolve,reject)=>{const onAbort=()=>{clearTimeout(timer);reject(shutdown.signal.reason);};const timer=setTimeout(()=>{shutdown.signal.removeEventListener("abort",onAbort);resolve();},2000);shutdown.signal.addEventListener("abort",onAbort,{once:true});});
    }
    throw new Error("Cloud status observation stopped.");
  }
  return {run,request,read,list,compare,wait,close:()=>shutdown.abort(new Error("Cloud Experiment observation stopped."))};
}
