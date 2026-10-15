import { createChatContextBrowser } from "./chat-context-browser.js";
import { readChatHostedTrainingAttachment } from "./chat-hosted-training-attachment.js";
import { readChatTrainingAttachment } from "./chat-training-attachment.js";
import type { createChatProfileExperiments } from "../evaluations/chat-profile-experiments.js";
import { createChatTeamExperiments } from "../evaluations/chat-team-experiments.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { chatResourceWorkspaces, chatTrainingAttachmentKey, ChatResourceSummarySchema, type RuntimeEvent, type ChatResourceSummary } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { LocalInferenceState } from "../evaluations/local-experiment-local-inference.js";
import type { ChatResourceAction } from "../openpond/chat-resource-action.js";
import {createChatDatasetSourceAction} from "./chat-dataset-sources.js";
import { createLocalDatasetService, localDatasetSummary } from "./local-dataset-service.js";
import { createLocalDatasetSync } from "./local-dataset-sync.js";
import {createChatCloudExperiments,type ChatExperimentView} from "../evaluations/chat-cloud-experiments.js";
import { createChatExperiments } from "../evaluations/chat-experiments.js";
import type { createDatasetImportService } from "./dataset-imports/import-service.js";
import type { HtmlVisualService } from "../visuals/visual-service.js";
import { chatExperimentReport } from "../evaluations/chat-experiment-report.js";
import { chatExperimentContext, createChatExperimentScopes } from "./chat-experiment-scope.js";
import { localGraderSummaries } from "./local-grader-resources.js";

export async function createChatResourceRuntime(deps:{store:SqliteStore;home:string;ownerId:string;state:LocalInferenceState;
  codexStatus?:()=>Promise<import("@openpond/contracts").CodexStatus>;
  access:Parameters<typeof createLocalDatasetSync>[0]["access"];append:(event:RuntimeEvent)=>Promise<void>;
  imports:ReturnType<typeof createDatasetImportService>;
  visuals:HtmlVisualService;
  improve?:(request:unknown)=>Promise<unknown>;
  teamExperiments:Parameters<typeof createChatTeamExperiments>[0]["service"];
  resolveInvocation:(token:string)=>Promise<{sessionId:string;turnId:string}>;
}) {
  let profile:ReturnType<typeof createChatProfileExperiments>|null=null;
  const scopes = createChatExperimentScopes(deps.store);
  const sync = createLocalDatasetSync({store:deps.store,access:deps.access});
  const datasets = createLocalDatasetService({store:deps.store,home:deps.home,syncAction:sync.action,onSaved:sync.onSaved,
    sourceAction:createChatDatasetSourceAction({store:deps.store,imports:deps.imports,create:input=>datasets.request(input)})});
  let experiments:Awaited<ReturnType<typeof createChatExperiments>>;
  try { experiments = await createChatExperiments({store:deps.store,home:deps.home,ownerId:deps.ownerId,state:deps.state,datasets,codexStatus:deps.codexStatus,hosted:{access:deps.access}}); } catch(error) {await sync.close();throw error;}
  const team = createChatTeamExperiments({service:deps.teamExperiments,
    resolveInvocation:deps.resolveInvocation,attach:async(context,resources)=>{for(const summary of resources)await emit(context.sessionId,context.turnId,summary);}});
  const cloud=createChatCloudExperiments({store:deps.store,datasets,access:deps.access});
  const browser = createChatContextBrowser({ store: deps.store, access: deps.access,
    resources: async () => {
      const page = await experiments.service.list({ teamId: experiments.scope }) as { items: import("@openpond/contracts").LocalExperimentRecord[] };
      return [...(await deps.store.listLocalDatasetListings()).map(localDatasetSummary), ...await Promise.all(page.items.map(record => experiments.summary(record))), ...await cloud.list()];
    },
    selectResource: async (sessionId, target) => { await request("dataset", { action: "set_focus", payload: { sessionId, kind: target?.kind ?? "dataset", id: target?.id ?? null, revision: target?.revision } }); },
  });
  async function dispatch(kind:"dataset"|"experiment",input:unknown,signal?:AbortSignal):Promise<unknown> {
    if(kind==="dataset")return datasets.request(input,signal);
    const envelope=z.object({action:z.string(),payload:z.record(z.string(),z.unknown()).default({})}).strict().parse(input);
    if (typeof envelope.payload.id === "string" && profile) {
      const linked=(await deps.store.chatResourceLinks({kind:"experiment",id:envelope.payload.id})).find(link=>link.summary.profileRef)?.summary;
      if(linked?.profileRef && ["read","status","result"].includes(envelope.action))return profile.inspect(linked.id,linked.profileRef);
    }
    if (typeof envelope.payload.id === "string" && team) {
      const linked = (await deps.store.chatResourceLinks({kind:"experiment",id:envelope.payload.id})).find(link=>link.summary.owner)?.summary;
      if (linked?.owner && ["read","status","result","cancel"].includes(envelope.action)) {
        const current = await team.inspect(linked.owner,linked.id);
        if (envelope.action !== "cancel") return current;
        await deps.teamExperiments!.request({teamId:linked.owner.teamId,action:"cancel",payload:{id:linked.id}});
        return team.inspect(linked.owner,linked.id);
      }
    }
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
  async function emit(sessionId:string,turnId:string,summary:ChatResourceSummary, showCard = true) {
    if(summary.profileRef) {
      if(!profile)throw new Error("Profile experiment association is unavailable.");
      await profile.authorize(summary.profileRef);
    }
    if(summary.owner) {
      const access=await deps.access();
      if(access.teamId!==summary.owner.teamId || access.actorId!==summary.owner.actorId)throw new Error("Resource owner changed before chat attachment.");
    }
    await deps.store.linkChatResource(sessionId,turnId,summary);
    // Pending authoring messages can have provisional IDs. Only saved resources
    // become configuration inputs; failed scaffolds must not create fake drafts.
    if (summary.kind !== "dataset" || summary.owner || summary.profileRef || await deps.store.readLocalDatasetListing(summary.id,summary.revision)) {
      if (summary.kind !== "dataset" && !summary.owner && !summary.profileRef && summary.datasetId) {
        const dataset = await deps.store.readLocalDatasetListing(summary.datasetId,summary.datasetRevision);
        if (dataset) await scopes.attach(sessionId,turnId,localDatasetSummary(dataset));
      }
      await scopes.attach(sessionId,turnId,summary);
    }
    // Team inputs are immutable pins, not installation-local authoring cards.
    if ((summary.owner || summary.profileRef) && summary.kind !== "experiment") return;
    await deps.append({id:randomUUID(),name:"workspace_action_result",source:"server",sessionId,turnId,timestamp:new Date().toISOString(),action:"chat_resource",status:"completed",data:{chatResource:summary,chatResourcePresentation:showCard ? "card" : "context"}});
  }
  function attachedSummaries(action:unknown, object:Record<string,unknown>):ChatResourceSummary[] {
    if (["list","models","schema","profile_catalog"].includes(String(action))) return [];
    return [object.summary,...Array.isArray(object.summaries) ? object.summaries : []]
      .map(value=>ChatResourceSummarySchema.safeParse(value)).filter(value=>value.success).map(value=>value.data);
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
    const envelope = z.object({context:z.object({sessionId:z.string().min(1),turnId:z.string().min(1)}).optional(),invocationToken:z.string().optional()}).passthrough().parse(raw);
    const {context:requestedContext,invocationToken,...input} = envelope;
    const context = invocationToken ? await deps.resolveInvocation!(invocationToken) : requestedContext;
    if (kind === "dataset" && ["context_catalog", "context_resolve", "context_runs", "context_select", "context_selection"].includes(String(input.action))) {
      const query = z.object({ sessionId: z.string().min(1).optional(), target: z.unknown().optional() }).strict().parse(input.payload ?? {});
      if (input.action === "context_catalog") return browser.catalog();
      if (input.action === "context_runs") return { runs: await browser.runs(query.target) };
      if (input.action === "context_resolve") return { selection: await browser.resolve(query.target) };
      if (input.action === "context_select") return { selection: await browser.select(query.target ?? null, query.sessionId) };
      const session = query.sessionId ? await deps.store.getSession(query.sessionId) : null;
      const target = session?.metadata?.chatContextSelection;
      if (session && target && typeof target === "object" && ["dataset", "experiment"].includes(String((target as {kind?:unknown}).kind))) {
        const state = chatExperimentContext(session.metadata);
        const selected = chatResourceWorkspaces(state).find(scope => scope.id === state.activeScopeId);
        const reference = target as { kind: string; id: string; revision?: number };
        if (reference.kind === "dataset" ? selected?.dataset?.id !== reference.id || selected?.dataset?.revision !== reference.revision : !selected?.runs.some(run => run.id === reference.id)) {
          await browser.select(target, session.id);
        }
      }
      return { selection: target ? await browser.resolve(target) : null };
    }
    if (kind === "experiment" && ["attach_training", "read_training"].includes(String(input.action))) {
      const ref = z.object({jobId:z.string().min(1).optional(),modelRunId:z.string().min(1).optional(),location:z.enum(["local","cloud"]).default("local"),apiOrigin:z.url().optional(),teamId:z.string().min(1).optional()}).strict()
        .refine(value=>Boolean(value.jobId || value.modelRunId),"Provide a training job or Model Run ID.").parse(input.payload);
      if (input.action === "attach_training" && !context) throw new Error("Training attachment requires the originating chat invocation.");
      const access = await deps.access();
      if (ref.location === "cloud" && (!ref.jobId || !ref.apiOrigin || !ref.teamId)) throw new Error("Hosted training requires its job, API origin and workspace.");
      const training = ref.location === "cloud"
        ? await readChatHostedTrainingAttachment(access,{jobId:ref.jobId!,apiOrigin:ref.apiOrigin!,teamId:ref.teamId!})
        : await readChatTrainingAttachment(deps.store,ref,{teamId:access.teamId,actorId:access.actorId});
      if (context && input.action === "attach_training") await scopes.attachTraining(context.sessionId,context.turnId,training);
      return {training};
    }
    if(kind==="dataset" && input.action==="resource_index") {
      const links=await deps.store.chatResourceLinks({});
      const unique=new Map<string,ChatResourceSummary>();
      const access=links.some(link=>link.summary.owner) ? await deps.access() : null;
      const visible=links.filter(link=>!link.summary.owner || link.summary.owner.teamId===access?.teamId && link.summary.owner.actorId===access?.actorId);
      for(const link of visible)unique.set(link.summary.kind+":"+link.summary.id,link.summary);
      for(const record of await deps.store.listLocalDatasetListings())unique.set("dataset:"+record.workspace.draft.id,localDatasetSummary(record));
      return {resources:[...unique.values()],links:visible.map(link=>({sessionId:link.sessionId,key:link.summary.kind+":"+link.summary.id}))};
    }
    if (kind === "dataset" && ["context","set_destination","set_model","set_focus","create_scope","select_scope","rename_scope"].includes(String(input.action))) {
      const query = z.object({sessionId:z.string().min(1),kind:z.enum(["dataset","experiment","grader"]).optional(),id:z.string().nullable().optional(),revision:z.number().int().positive().optional(),operationId:z.string().min(1).max(240).optional(),scopeId:z.string().min(1).optional(),graderId:z.string().min(1).nullable().optional(),name:z.string().optional(),evaluationModel:z.string().min(1).max(500).optional(),executionLocation:z.enum(["local","cloud"]).optional(),expectedSelectionVersion:z.number().int().nonnegative().optional(),visualPublicationId:z.string().optional()}).strict().parse(context ? {...input.payload as object,sessionId:context.sessionId} : input.payload);
      const session = await deps.store.getSession(query.sessionId);
      if (!session || session.systemKind || session.workspaceKind === "sandbox") throw new Error("This conversation cannot use installation-local resource focus.");
      if(query.visualPublicationId)await deps.visuals.read(session.id,query.visualPublicationId);
      const datasetChoices = input.action === "context" ? (await deps.store.listLocalDatasetListings()).map(localDatasetSummary) : [];
      const experimentChoices:ChatResourceSummary[] = [];
      if (input.action === "context" || query.kind === "experiment") {
      const page = await experiments.service.list({teamId:experiments.scope}) as {items:import("@openpond/contracts").LocalExperimentRecord[]};
      const localChoices = await Promise.all(page.items.map(record=>experiments.summary(record)));
      const linkedTeam = team ? (await deps.store.chatResourceLinks({sessionId:session.id,kind:"experiment"})).filter(link=>link.summary.owner) : [];
      const ownedChoices:ChatResourceSummary[]=[];
      for(const link of new Map(linkedTeam.map(link=>[link.summary.id,link])).values()) {
        try {const current=await team!.inspect(link.summary.owner!,link.summary.id);
          if(!ownedChoices.some(summary=>summary.id===current.summary.id))ownedChoices.push(current.summary);
        } catch {/* Records from a previous account are not choices in the active account. */}
      }
      const linkedProfiles=(await deps.store.chatResourceLinks({sessionId:session.id,kind:"experiment"})).filter(link=>link.summary.profileRef);
      const profileChoices:ChatResourceSummary[]=[];
      if(profile)for(const link of new Map(linkedProfiles.map(link=>[link.summary.id,link])).values()) {
        try {profileChoices.push((await profile.inspect(link.summary.id,link.summary.profileRef)).summary);}catch {/* The selected Profile owns these choices. */}
      }
      experimentChoices.push(...localChoices,...ownedChoices,...profileChoices,...await cloud.list());
      }
      let scopeContext = chatExperimentContext(session.metadata);
      // Rehydrate saved training references from their owner and hide records
      // admitted by a different account. Persisted scope snapshots are not
      // authorization and are not a live status source.
      async function refreshTraining(state:typeof scopeContext) {
        if (!chatResourceWorkspaces(state).some(scope=>scope.training?.length)) return;
        const access = await deps.access().catch(()=>null);
        for (const scope of chatResourceWorkspaces(state)) {
          const visible = [];
          for (const reference of scope.training ?? []) {
            if (!access || reference.owner.teamId !== access.teamId || reference.owner.actorId !== access.actorId) continue;
            if (reference.location === "cloud" && new URL(reference.apiOrigin).origin !== new URL(access.apiBaseUrl).origin) continue;
            try { visible.push(reference.location === "cloud"
              ? await readChatHostedTrainingAttachment(access,{jobId:reference.jobId,apiOrigin:reference.apiOrigin,...reference.owner})
              : await readChatTrainingAttachment(deps.store,{jobId:reference.jobId},{teamId:access.teamId,actorId:access.actorId})); }
            catch (error) {
              // A hosted outage must not look like a successful empty result.
              // The client retains the previous focus and displays the error.
              if (reference.location === "cloud") throw error;
            }
          }
          scope.training = visible;
          if (!visible.some(reference=>chatTrainingAttachmentKey(reference)===scope.selectedTrainingKey)) scope.selectedTrainingKey = null;
        }
      }
      await refreshTraining(scopeContext);
      const sourceTurn=context ? await deps.store.getTurn(context.turnId) : null;
      if(context && input.action!=="context") {
        const version=sourceTurn?.metadata.chatExperimentSelectionVersion;
        if(typeof version==="number")query.expectedSelectionVersion=version;
        else if(sourceTurn && scopeContext.selectedAt && scopeContext.selectedAt>sourceTurn.startedAt)throw new Error("Resource focus changed after this turn began. Continue from the current selection.");
        else query.expectedSelectionVersion=scopeContext.selectionVersion;
      }
      const focusFor = (state:typeof scopeContext) => {
        const scope = chatResourceWorkspaces(state).find(candidate=>candidate.id===state.activeScopeId);
        return {dataset:scope?.dataset ?? null,experiment:scope?.runs.find(run=>run.id===scope.selectedRunId) ?? null};
      };
      let focus = focusFor(scopeContext);
      async function verifyOwner(dataset:ChatResourceSummary) {
        if(dataset.profileRef) {
          if(!profile)throw new Error("Profile experiment association is unavailable.");
          await profile.authorize(dataset.profileRef);
        }
        if(!dataset.owner)return;
        const access=await deps.access();
        if(access.teamId!==dataset.owner.teamId || access.actorId!==dataset.owner.actorId)throw new Error("Select the account and workspace that own this dataset pin.");
      }
      async function gradersFor(dataset:ChatResourceSummary|null) {
        if(!dataset)return [];
        if(dataset.profileRef || dataset.owner) {
          await verifyOwner(dataset);
          if(focus.experiment?.profileRef && profile)return (await profile.inspect(focus.experiment.id,focus.experiment.profileRef)).inputs.filter(resource=>resource.kind==="grader");
          if(focus.experiment?.owner && team)return (await team.inspect(focus.experiment.owner,focus.experiment.id)).inputs.filter(resource=>resource.kind==="grader");
          return chatResourceWorkspaces(scopeContext).find(scope=>scope.id===scopeContext.activeScopeId)?.graders.filter(grader=>grader.datasetId===dataset.id && grader.datasetRevision===dataset.revision) ?? [];
        }
        return localGraderSummaries(await datasets.readListing(dataset.id,dataset.revision)).map(grader=>({...grader,rows:[]}));
      }
      async function selectedFocus(state:typeof scopeContext) {
        await refreshTraining(state);
        if(context)await deps.store.updateTurn(context.turnId,current=>({...current,metadata:{...current.metadata,
          chatExperimentScopeId:state.activeScopeId,chatExperimentSelectionVersion:state.selectionVersion}}));
        return {...focusFor(state),scopeContext:state};
      }
      if (input.action === "set_destination") {
        if (!query.executionLocation) throw new Error("Choose Local or Hosted execution.");
        if (query.executionLocation === "cloud" && (focus.dataset?.owner || focus.dataset?.profileRef)) throw new Error("Hosted execution for this resource owner is not available in these controls.");
        scopeContext = await scopes.select(session.id,{executionLocation:query.executionLocation,expectedSelectionVersion:query.expectedSelectionVersion});
        return selectedFocus(scopeContext);
      }
      if (input.action === "set_model") {
        const catalog = await experiments.request({action:"models"}) as {models:{providerId:string;id:string}[]};
        if (!query.evaluationModel || !catalog.models.some(model=>`${model.providerId}/${model.id}`===query.evaluationModel)) throw new Error("The selected evaluation model is unavailable. Refresh the model choices.");
        scopeContext = await scopes.select(session.id,{evaluationModel:query.evaluationModel,expectedSelectionVersion:query.expectedSelectionVersion});
        return selectedFocus(scopeContext);
      }
      if (input.action === "create_scope") {
        if (!query.operationId) throw new Error("Creating an experiment scope requires a stable operationId.");
        scopeContext = await scopes.create(session.id,query.operationId,query.expectedSelectionVersion,query.graderId,await gradersFor(focus.dataset));
        return selectedFocus(scopeContext);
      }
      if (input.action === "select_scope" || input.action === "rename_scope") {
        if (!query.scopeId) throw new Error("Select an experiment scope.");
        scopeContext = await scopes.select(session.id,{scopeId:query.scopeId,...input.action === "rename_scope" ? {name:z.string().trim().min(1).max(500).parse(query.name)} : {},expectedSelectionVersion:query.expectedSelectionVersion});
        return selectedFocus(scopeContext);
      }
      if (input.action === "context") {
        if(focus.experiment?.profileRef && profile)focus={...focus,experiment:(await profile.inspect(focus.experiment.id,focus.experiment.profileRef)).summary};
        if(focus.experiment?.owner && team)focus={...focus,experiment:(await team.inspect(focus.experiment.owner,focus.experiment.id)).summary};
        if(focus.experiment?.location==="local" && !focus.experiment.owner && !focus.experiment.profileRef) {
          const record=await deps.store.readLocalExperimentRecord(experiments.scope,focus.experiment.id);
          focus={...focus,experiment:record ? await experiments.summary(record) : null};
        }
        if(focus.dataset?.owner || focus.dataset?.profileRef)await verifyOwner(focus.dataset);
        if(focus.dataset && !focus.dataset.owner && !focus.dataset.profileRef) {const pinned=await deps.store.readLocalDatasetListing(focus.dataset.id,focus.dataset.revision);focus={...focus,dataset:pinned ? localDatasetSummary(pinned) : null};}
        const graders = await gradersFor(focus.dataset);
        return {focus:{...focus,scopeContext},datasets:datasetChoices,experiments:experimentChoices,graders};
      }
      if (!query.kind) throw new Error("Select the resource focus kind.");
      if (query.kind === "grader") {
        scopeContext = await scopes.select(session.id,{scopeId:query.scopeId,graders:await gradersFor(focus.dataset),graderId:query.id ?? null,expectedSelectionVersion:query.expectedSelectionVersion});
        return selectedFocus(scopeContext);
      }
      if (query.kind === "dataset") {
        const sameOwnerPin = (focus.dataset?.owner || focus.dataset?.profileRef) && query.id === focus.dataset.id && query.revision === focus.dataset.revision;
        const dataset = sameOwnerPin ? focus.dataset : query.id ? localDatasetSummary(await datasets.readListing(query.id,query.revision)) : null;
        if(dataset?.owner || dataset?.profileRef)await verifyOwner(dataset);
        if (query.id && !dataset) throw new Error("Local Dataset was not found.");
        focus = {dataset:dataset ?? null,experiment:dataset && focus.experiment && focus.experiment.datasetId === dataset.id && focus.experiment.datasetRevision === dataset.revision ? focus.experiment : null};
      } else {
        const experiment = query.id ? experimentChoices.find(e=>e.id === query.id) : null;
        if (query.id && !experiment) throw new Error("Local Experiment was not found.");
        const associated=experiment?.profileRef && profile ? (await profile.inspect(experiment.id,experiment.profileRef)).inputs.find(resource=>resource.kind==="dataset") : experiment?.owner && team ? (await team.inspect(experiment.owner,experiment.id)).inputs.find(resource=>resource.kind==="dataset") : null;
        const pinned = !experiment?.owner && !experiment?.profileRef && experiment?.datasetId ? await deps.store.readLocalDatasetListing(experiment.datasetId,experiment.datasetRevision) : null;
        focus = {experiment:experiment ?? null,dataset:associated ?? (pinned ? localDatasetSummary(pinned) : null)};
      }
      const graders = await gradersFor(focus.dataset);
      scopeContext = await scopes.select(session.id,{scopeId:query.scopeId,dataset:focus.dataset,graders,...focus.experiment ? {run:focus.experiment} : {},expectedSelectionVersion:query.expectedSelectionVersion,operationId:query.operationId,visualPublicationId:query.visualPublicationId});
      return selectedFocus(scopeContext);
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
    // Discovery opens dataset browsing without allocating an experiment or selecting a record.
    if (context && input.action === "list") {
      const before = chatExperimentContext((await deps.store.getSession(context.sessionId))?.metadata);
      const state = await scopes.ensure(context.sessionId);
      await deps.store.updateTurn(context.turnId, turn => {
        const opened = !before.activeScopeId && state.selectionVersion === before.selectionVersion + 1;
        const unchanged = state.selectionVersion === before.selectionVersion && (!state.selectedAt || state.selectedAt <= turn.startedAt);
        if (turn.metadata.chatExperimentScopeId || (!opened && !unchanged)) return turn;
        return {...turn, metadata:{...turn.metadata, chatExperimentScopeId:state.activeScopeId, chatExperimentSelectionVersion:state.selectionVersion}};
      });
      await deps.append({id:randomUUID(),name:"workspace_action_result",source:"server",sessionId:context.sessionId,
        turnId:context.turnId,timestamp:new Date().toISOString(),action:"chat_resource",status:"completed",data:{discovery:true}});
    }
    if (context && result && typeof result === "object") {
      const object = result as Record<string,unknown>;
      const summaries = attachedSummaries(input.action,object);
      for (const summary of summaries) await emit(context.sessionId,context.turnId,summary, !["read","read_grader","list_graders"].includes(String(input.action)));
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
    const summaries = attachedSummaries(action,object);
    for (const summary of summaries) await emit(context.session.id,context.turnId,summary, !["read","read_grader","list_graders"].includes(String(action)));
    if (kind === "experiment" && typeof action === "string" && ["run","run_cloud"].includes(action)) {
      for (const summary of summaries) void wait(summary.id).then(async result=> {
        const updated = result as {summary:ChatResourceSummary};
        await emit(context.session.id,context.turnId,{...updated.summary,datasetId:summary.datasetId,datasetRevision:summary.datasetRevision});
      }).catch(() => {});
    }
    return result;
  };
  return {datasets,experiments,request,execute,
    setProfileOwner:(owner:ReturnType<typeof createChatProfileExperiments>)=>{if(profile)throw new Error("Profile owner is already registered.");profile=owner;},
    associate:async(context:{sessionId:string;turnId:string},resources:ChatResourceSummary[])=>{for(const summary of resources)await emit(context.sessionId,context.turnId,summary);},
    teamRequest:team.request,close:async()=>{cloud.close();await sync.close();await experiments.service.close();}};
}
