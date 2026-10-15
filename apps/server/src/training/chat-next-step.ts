import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ChatNextStepActionSchema, ChatNextStepSchema, chatResourceWorkspaces, chatTrainingReference,
  type ChatContextSelection, type ChatResourceSummary, type ChatNextStep, type ChatNextStepAction, type Session, type TaskResourceContext } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { chatExperimentContext } from "./chat-experiment-scope.js";

export function nextStepSessionEligible(session: Session): boolean {
  return !session.systemKind && session.metadata?.profileEvaluationRun === undefined && session.metadata?.standaloneExperiment === undefined
    && session.metadata?.localProfileExperiment === undefined && session.metadata?.refinementCandidate === undefined
    && session.metadata?.source !== "experiment-improvement"
    && !["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "");
}
const Request = z.object({ sessionId: z.string(), operation: z.enum(["read", "accept", "dismiss", "recommend"]).default("read"),
  id: z.string().optional(), action: ChatNextStepActionSchema.optional() }).strict();
function selectionGuard(session:Session) {
  return contentHash({focus:session.metadata?.chatContextSelection,scope:session.metadata?.chatExperimentContext,status:session.status});
}
const Terminal = new Set(["completed", "failed", "interrupted"]);

type Candidate = { action: ChatNextStepAction; label: string; draft: string; baseline?: ChatResourceSummary };
export function eligibleNextSteps(focus: ChatContextSelection, session: Session): Candidate[] {
  const run = focus.resource?.kind === "experiment" ? focus.resource : null;
  if (focus.training) {
    const job = focus.training, state = job.location === "cloud" ? job.job.state : job.executionState;
    if (!["succeeded", "completed", "failed", "cancelled", "budget_exhausted"].includes(state)) return [];
    return [{ action: "diagnose", label: "Inspect this training result", draft: `Inspect retained training run ${job.jobId}. Explain its results, failures, checkpoint lineage and next useful step. Do not start inference, evaluations, training or paid work.` }];
  }
  const dataset = focus.dataset ?? (focus.resource?.kind === "dataset" ? focus.resource : null);
  if (!dataset || !focus.resource) return [];
  const pin = `${dataset.name}, dataset ${dataset.id} revision ${dataset.revision}`;
  if (run) {
    if (["failed", "cancelled", "interrupted", "budget_exhausted"].includes(run.state)) return [{ action: "diagnose", label: "Diagnose this experiment", draft: `Diagnose retained experiment ${run.id} on ${pin}. Inspect its failures and explain the next useful step without changing inputs or starting another run.` }];
    if (!["completed", "complete", "succeeded"].includes(run.state)) return [];
    const scopes = chatResourceWorkspaces(chatExperimentContext(session.metadata));
    const baseline = scopes.flatMap(scope => scope.runs).find(item => item.id !== run.id && item.kind === "experiment" && item.state === "completed"
      && item.datasetId === run.datasetId && item.datasetRevision === run.datasetRevision && item.evaluationHash && item.evaluationHash === run.evaluationHash
      && item.location === run.location && JSON.stringify(item.owner) === JSON.stringify(run.owner) && JSON.stringify(item.profileRef) === JSON.stringify(run.profileRef));
    return [ ...(baseline ? [{ action: "compare" as const, label: "Compare the retained results", baseline, draft: `Compare retained experiments ${baseline.id} and ${run.id}. Verify matched inputs and graders, explain score differences and limitations, and do not start new evaluations.` }] : []),
      { action: "inspect_results", label: "Inspect this experiment’s results", draft: `Inspect retained experiment ${run.id} on ${pin}. Explain scores, case failures and limitations before proposing any changes. Do not start new evaluations or training.` } ];
  }
  if (!(dataset.taskCount && dataset.taskCount > 0)) return [];
  const graders = focus.graders ?? [];
  if (!graders.length) return [];
  if (!graders.every(grader => ["passed", "valid", "ready"].includes(grader.state.toLowerCase()))) return [{ action: "check_graders", label: "Check the dataset graders", draft: `Test the graders for ${pin} against their saved fixtures. Report missing coverage and failures separately from model scores. Do not change the dataset or start an evaluation or training.` }];
  return [{ action: "prepare_evaluation", label: "Prepare an evaluation", draft: `Prepare an evaluation plan for ${pin} with its saved graders. Confirm the evaluation model, execution destination, cost and spending limit before submitting anything. Do not start an evaluation or training yet.` }];
}

export function createChatNextStepService(deps: { store: SqliteStore; current(sessionId: string): Promise<ChatContextSelection | null> }) {
  const locks = new Map<string, Promise<unknown>>();
  async function snapshot(sessionId: string, activeTurnId?: string) {
    let session = await deps.store.getSession(sessionId);
    if (!session || !nextStepSessionEligible(session)) return null;
    const turn = await deps.store.latestTurnForSession(sessionId);
    if (!turn || (activeTurnId ? turn.id !== activeTurnId || turn.status !== "in_progress" : !Terminal.has(turn.status))) return null;
    if (!activeTurnId && session.status === "active") return null;
    const inbox = await deps.store.taskInboxSnapshot(sessionId);
    if (!activeTurnId && inbox.inputs.some(input => input.state === "pending")) return null;
    const initialGuard = selectionGuard(session);
    const focus = await deps.current(sessionId);
    if (!focus) return null;
    session = await deps.store.getSession(sessionId);
    const latest = await deps.store.latestTurnForSession(sessionId);
    if (!session || selectionGuard(session)!==initialGuard || !nextStepSessionEligible(session) || latest?.id !== turn.id || latest.status !== turn.status) return null;
    const candidates = eligibleNextSteps(focus, session);
    if (!candidates.length) return null;
    const state = chatExperimentContext(session.metadata);
    const scope = chatResourceWorkspaces(state).find(item => item.id === (focus.target.scopeId ?? state.activeScopeId));
    if (!scope) return null;
    const dataset = focus.dataset ?? (focus.resource?.kind === "dataset" ? focus.resource : null);
    const contexts: TaskResourceContext[] = scope ? [{scopeId:scope.id, selectionVersion:state.selectionVersion,
      executionLocation:focus.target.location, evaluationModel:focus.resource?.model ?? scope.evaluationModel,
      resources:[dataset,focus.resource?.kind === "experiment" ? focus.resource : null,...focus.graders ?? []].filter(item=>item!==null && item!==undefined).map(item=>({kind:item.kind,id:item.id,revision:item.revision,datasetId:item.datasetId,datasetRevision:item.datasetRevision,owner:item.owner,profileRef:item.profileRef})),
      ...(focus.training ? {training:[chatTrainingReference(focus.training)]} : {})}] : [];
    // The complete canonical snapshot fences changed inputs, configuration and results.
    const fingerprint = contentHash({sessionId,turnId:turn.id,target:focus.target,resource:focus.resource,dataset,graders:focus.graders,
      training:focus.training,contexts,candidates});
    return {session,turn,focus,contexts,candidates,fingerprint,guard:selectionGuard(session)};
  }
  async function perform(raw: unknown, origin?: {sessionId:string;turnId:string}) {
    const input = Request.parse(raw);
    if (origin && input.sessionId !== origin.sessionId) throw new Error("Suggestion belongs to another chat.");
    if (input.operation === "recommend" && !origin) throw new Error("Recommendations require the active originating turn.");
    const active = input.operation === "recommend" ? origin!.turnId : undefined;
    const state = await snapshot(input.sessionId,active);
    if (!state) return {suggestion:null,eligible:[]};
    const {session,turn,focus,contexts,candidates,fingerprint,guard} = state;
    const update = (apply:(current:Session)=>Session) => deps.store.updateSession(session.id,current=>{
      if (selectionGuard(current)!==guard) throw new Error("The selected resources changed. Review the current suggestion again.");
      return apply(current);
    });
    if (input.operation === "recommend") {
      if (!input.action) return {eligible:candidates};
      if (!candidates.some(candidate=>candidate.action===input.action)) throw new Error("That next step is not eligible for the current saved evidence.");
      await update(current=>({...current,metadata:{...current.metadata,chatNextStepRecommendation:{turnId:turn.id,fingerprint,action:input.action}}}));
      return {recommended:input.action,eligible:candidates};
    }
    const recommendation = z.object({turnId:z.string(),fingerprint:z.string(),action:ChatNextStepActionSchema}).safeParse(session.metadata?.chatNextStepRecommendation);
    const candidate = recommendation.success && recommendation.data.turnId===turn.id && recommendation.data.fingerprint===fingerprint
      ? candidates.find(item=>item.action===recommendation.data.action) ?? candidates[0]! : candidates[0]!;
    const baseId = contentHash({fingerprint,action:candidate.action});
    const storedOffer = z.object({baseId:z.string(),id:z.string(),state:z.enum(["offered","accepted","dismissed"])}).safeParse(session.metadata?.chatNextStepOffer);
    const offer = storedOffer.success && storedOffer.data.baseId === baseId ? storedOffer.data : null;
    if (offer?.state === "dismissed") return {suggestion:null,eligible:[]};
    let id = offer?.id ?? baseId;
    if (input.operation === "read" && offer?.state === "accepted") {
      // Clearing an accepted editable draft may offer the same valid next step
      // again. Each offer still accepts once, including concurrent key/clicks.
      id = contentHash({baseId,previousOfferId:id});
      await update(current=>({...current,metadata:{...current.metadata,chatNextStepOffer:{baseId,id,state:"offered"}}}));
    } else if (offer?.state === "accepted") return {suggestion:null,eligible:[]};
    const pinnedContexts = candidate.baseline ? contexts.map((context,index)=>index===0 ? {...context,resources:[...context.resources,{kind:candidate.baseline!.kind,id:candidate.baseline!.id,revision:candidate.baseline!.revision,datasetId:candidate.baseline!.datasetId,datasetRevision:candidate.baseline!.datasetRevision,owner:candidate.baseline!.owner,profileRef:candidate.baseline!.profileRef}]} : context) : contexts;
    const suggestion: ChatNextStep = ChatNextStepSchema.parse({id,sessionId:session.id,sourceTurnId:turn.id,action:candidate.action,label:candidate.label,draft:candidate.draft,contexts:pinnedContexts,focus});
    if (input.operation === "read") return {suggestion};
    if (input.id!==id) return {suggestion:null,stale:true};
    await update(current=>({...current,metadata:{...current.metadata,chatNextStepOffer:{baseId,id,state:input.operation==="accept" ? "accepted" : "dismissed"}}}));
    const settled = await snapshot(session.id);
    if (!settled || settled.fingerprint !== fingerprint || settled.guard !== guard) return {suggestion:null,stale:true};
    return {suggestion:input.operation==="accept" ? suggestion : null};
  }
  return { request(raw:unknown,origin?:{sessionId:string;turnId:string}) {
    const {sessionId}=Request.parse(raw);
    const previous=locks.get(sessionId) ?? Promise.resolve();
    const pending=previous.catch(()=>{}).then(()=>perform(raw,origin));
    locks.set(sessionId,pending);
    void pending.finally(()=>{if(locks.get(sessionId)===pending)locks.delete(sessionId);}).catch(()=>{});
    return pending;
  }};
}
