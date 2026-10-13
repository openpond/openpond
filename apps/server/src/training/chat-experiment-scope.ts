import { createHash, randomUUID } from "node:crypto";
import {
  ChatExperimentContextSchema,
  ChatTrainingAttachmentSchema,
  type ChatTrainingAttachment,
  TaskResourceContextsSchema,
  type ChatExperimentContext,
  type ChatExperimentScope,
  type ChatResourceSummary,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

const empty = (): ChatExperimentContext => ({ scopes: [], activeScopeId: null, selectionVersion: 0, selectedAt: null, selectionOperations:{} });
export function chatExperimentContext(metadata: Record<string, unknown> | undefined): ChatExperimentContext {
  const parsed = ChatExperimentContextSchema.safeParse(metadata?.chatExperimentContext);
  return parsed.success ? parsed.data : empty();
}

export function createChatExperimentScopes(store: SqliteStore) {
  async function change(sessionId: string, apply: (state: ChatExperimentContext) => void) {
    // updateSession serializes this callback with all other session writes.
    // Read state inside the callback so concurrent selections cannot lose scopes.
    const session = await store.updateSession(sessionId, current => {
      if (current.systemKind || ["sandbox", "sandbox_template"].includes(current.workspaceKind ?? "")) throw new Error("This conversation cannot select local resources.");
      const state = chatExperimentContext(current.metadata);
      apply(state);
      return { ...current, metadata: { ...current.metadata, chatExperimentContext: ChatExperimentContextSchema.parse(state) } };
    });
    if (!session) throw new Error("Conversation was not found.");
    return chatExperimentContext(session.metadata);
  }

  function make(state: ChatExperimentContext, operationId: string, now: string): ChatExperimentScope {
    const existing = state.scopes.find(scope => scope.operationId === operationId);
    if (existing) return existing;
    const ordinal = Math.max(0, ...state.scopes.map(scope => scope.ordinal)) + 1;
    const scope: ChatExperimentScope = { id: `experiment-scope-${randomUUID()}`, ordinal, name: `Experiment ${ordinal}`, dataset: null,
      graders: [], selectedGraderId: null, runs: [], selectedRunId: null, turnIds: [], operationId, createdAt: now, updatedAt: now };
    state.scopes.push(scope);
    return scope;
  }

  async function create(sessionId: string, operationId: string, expectedSelectionVersion?:number) {
    return change(sessionId, state => {
      if(expectedSelectionVersion!==undefined && expectedSelectionVersion!==state.selectionVersion)throw new Error("Resource selection changed. Refresh before creating another experiment.");
      if (state.scopes.some(scope => scope.operationId === operationId)) return;
      const now = new Date().toISOString();
      const scope = make(state, operationId, now);
      if (state.activeScopeId !== scope.id) { state.activeScopeId = scope.id; state.selectionVersion++; state.selectedAt = now; }
    });
  }

  async function select(sessionId: string, input: { scopeId?: string; name?: string; dataset?: ChatResourceSummary | null;
    graders?: ChatResourceSummary[]; graderId?: string | null; run?: ChatResourceSummary; expectedSelectionVersion?: number;operationId?:string;visualPublicationId?:string }) {
    return change(sessionId, state => {
      const hash=createHash("sha256").update(JSON.stringify({scopeId:input.scopeId,name:input.name,visualPublicationId:input.visualPublicationId,dataset:input.dataset ? [input.dataset.id,input.dataset.revision] : input.dataset,graderId:input.graderId,run:input.run?.id})).digest("hex");
      const prior=input.operationId && Object.hasOwn(state.selectionOperations,input.operationId) ? state.selectionOperations[input.operationId] : undefined;
      if(prior) {
        if(prior.hash!==hash)throw new Error("Selection operation was reused for another resource.");
        if(prior.version!==state.selectionVersion)throw new Error("A newer resource selection exists. Reopen the picker before selecting again.");
        return;
      }
      if (input.expectedSelectionVersion !== undefined && input.expectedSelectionVersion !== state.selectionVersion) throw new Error("Resource selection changed. Refresh before selecting again.");
      const now = new Date().toISOString();
      let scope = state.scopes.find(candidate => candidate.id === (input.scopeId ?? state.activeScopeId));
      if (input.scopeId && !scope) throw new Error("Experiment scope does not belong to this conversation.");
      if (!scope) scope = make(state, `selection-${randomUUID()}`, now);
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name || name.length > 500) throw new Error("Provide an experiment name of 1–500 characters.");
        scope.name = name;
      }
      if (input.dataset !== undefined) {
        scope.dataset = input.dataset;
        scope.selectedRunId = null;
        scope.graders = input.graders ?? [];
        scope.selectedGraderId = null;
      }
      if (input.graders !== undefined && input.dataset === undefined) scope.graders = input.graders.map(grader=>({...grader,rows:[]}));
      if (input.graderId !== undefined) {
        if (input.graderId && !scope.graders.some(grader=>grader.id===input.graderId)) throw new Error("Grader does not belong to the selected dataset revision.");
        scope.selectedGraderId = input.graderId;
      }
      if (input.run) {
        const index = scope.runs.findIndex(run => run.id === input.run!.id);
        if (index < 0) scope.runs.push(input.run); else scope.runs[index] = input.run;
        scope.selectedRunId = input.run.id;
      }
      scope.updatedAt = now;
      state.activeScopeId = scope.id; state.selectionVersion++; state.selectedAt = now;
      if(input.operationId)state.selectionOperations=Object.fromEntries([...Object.entries(state.selectionOperations),[input.operationId,{hash,version:state.selectionVersion,...input.visualPublicationId ? {visualPublicationId:input.visualPublicationId} : {},...input.run || input.dataset ? {resource:{...(input.run ?? input.dataset)!,rows:[]}} : {}}]]);
    });
  }

  async function attach(sessionId: string, turnId: string, summary: ChatResourceSummary) {
    // Grader fixtures can contain privileged answers. Configuration context
    // retains identifiers and metadata, never grader example outputs.
    if (summary.kind === "grader") summary = { ...summary, rows: [] };
    const turn = await store.getTurn(turnId);
    if (!turn || turn.sessionId !== sessionId) throw new Error("Resource turn does not belong to this conversation.");
    return change(sessionId, state => {
      const now = new Date().toISOString();
      let targetId = typeof turn.metadata.chatExperimentScopeId === "string" ? turn.metadata.chatExperimentScopeId : null;
      const contexts = TaskResourceContextsSchema.safeParse(turn.metadata.chatResourceContexts);
      if (!targetId && contexts.success && contexts.data.length) {
        const matches = contexts.data.filter(context => context.resources.some(resource => {
          const sameOwner = resource.owner?.teamId === summary.owner?.teamId
            && resource.owner?.actorId === summary.owner?.actorId
            && JSON.stringify(resource.profileRef) === JSON.stringify(summary.profileRef);
          return sameOwner && ((resource.kind === summary.kind && resource.id === summary.id && resource.revision === summary.revision)
            || (resource.kind === "dataset" && resource.id === summary.datasetId && resource.revision === summary.datasetRevision));
        }));
        const targets = [...new Set(matches.map(context => context.scopeId))];
        if (targets.length !== 1) throw new Error("Select the intended experiment scope before attaching this resource; the draft has multiple or unmatched targets.");
        targetId = targets[0]!;
      }
      // An explicit operation selection wins even when this turn previously
      // produced a result for another experiment.
      let scope = targetId
        ? state.scopes.find(candidate => candidate.id === targetId)
        : state.scopes.find(candidate => candidate.turnIds.includes(turnId));
      const late = typeof turn.metadata.chatExperimentSelectionVersion === "number"
        ? turn.metadata.chatExperimentSelectionVersion !== state.selectionVersion
        : state.selectedAt !== null && state.selectedAt > turn.startedAt;
      if (!scope && !targetId && !late) scope = state.scopes.find(candidate => candidate.id === state.activeScopeId);
      if (targetId && !scope) throw new Error("Resource scope does not belong to this conversation.");
      if (!scope) scope = make(state, `turn-${turnId}`, now);
      if (!scope.turnIds.includes(turnId)) scope.turnIds.push(turnId);
      const sameOwner = scope.dataset?.owner?.teamId === summary.owner?.teamId
        && scope.dataset?.owner?.actorId === summary.owner?.actorId
        && (!scope.dataset?.profileRef || JSON.stringify(scope.dataset.profileRef)===JSON.stringify(summary.profileRef));
      if (summary.kind === "dataset") {
        if ((!late || !scope.dataset || (scope.dataset.id === summary.id && scope.dataset.revision === summary.revision && sameOwner))
          && (!scope.dataset || scope.dataset.id !== summary.id || summary.revision >= scope.dataset.revision)) {
          const changed = scope.dataset?.id !== summary.id || scope.dataset?.revision !== summary.revision || !sameOwner || scope.dataset?.contentHash !== summary.contentHash;
          scope.dataset = summary;
          if (changed) { scope.graders = []; scope.selectedGraderId = null; scope.selectedRunId = null; }
        }
      } else if (summary.kind === "grader") {
        if (scope.dataset && scope.dataset.id === summary.datasetId && scope.dataset.revision === summary.datasetRevision && sameOwner) {
          const index = scope.graders.findIndex(grader => grader.id === summary.id);
          if (index < 0) scope.graders.push(summary);
          else if (summary.revision >= scope.graders[index]!.revision) scope.graders[index] = summary;
        }
      } else {
        const index = scope.runs.findIndex(run => run.id === summary.id);
        if (index < 0) scope.runs.push(summary); else scope.runs[index] = summary;
        // A run can arrive after its dataset was revised in the same turn.
        // Retain it without presenting that newer draft as the run's inputs.
        const matchesInputs = scope.dataset && scope.dataset.id === summary.datasetId
          && scope.dataset.revision === summary.datasetRevision
          && sameOwner;
        if (!late && matchesInputs) scope.selectedRunId = summary.id;
      }
      scope.updatedAt = now;
      // Background completion updates the originating scope without selecting it.
      if (!state.activeScopeId && !late) state.activeScopeId = scope.id;
    });
  }
  async function attachTraining(sessionId: string, turnId: string, input: ChatTrainingAttachment) {
    const training = ChatTrainingAttachmentSchema.parse(input);
    const turn = await store.getTurn(turnId);
    if (!turn || turn.sessionId !== sessionId) throw new Error("Resource turn does not belong to this conversation.");
    return change(sessionId, state => {
      const contexts = TaskResourceContextsSchema.safeParse(turn.metadata.chatResourceContexts);
      let targetId = typeof turn.metadata.chatExperimentScopeId === "string" ? turn.metadata.chatExperimentScopeId : null;
      if (!targetId && contexts.success && contexts.data.length) {
        const targets = [...new Set(contexts.data.map(context => context.scopeId))];
        if (targets.length !== 1) throw new Error("Select the intended experiment scope before attaching training; the draft has multiple targets.");
        targetId = targets[0]!;
      }
      const late = typeof turn.metadata.chatExperimentSelectionVersion === "number"
        ? turn.metadata.chatExperimentSelectionVersion !== state.selectionVersion
        : state.selectedAt !== null && state.selectedAt > turn.startedAt;
      let scope = targetId ? state.scopes.find(candidate => candidate.id === targetId)
        : state.scopes.find(candidate => candidate.turnIds.includes(turnId));
      if (targetId && !scope) throw new Error("Resource scope does not belong to this conversation.");
      if (!scope && !late) scope = state.scopes.find(candidate => candidate.id === state.activeScopeId);
      const now = new Date().toISOString();
      if (!scope) scope = make(state, `turn-${turnId}`, now);
      if (!scope.turnIds.includes(turnId)) scope.turnIds.push(turnId);
      const records = scope.training ??= [];
      const index = records.findIndex(record => record.jobId === training.jobId
        && record.owner.teamId === training.owner.teamId && record.owner.actorId === training.owner.actorId);
      if (index < 0) records.push(training);
      else if (training.updatedAt >= records[index]!.updatedAt) records[index] = training;
      if (!late) scope.selectedTrainingJobId = training.jobId;
      scope.updatedAt = now;
      if (!state.activeScopeId && !late) state.activeScopeId = scope.id;
    });
  }
  return { create, select, attach, attachTraining };
}
