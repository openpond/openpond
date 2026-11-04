import { readChatRetainedResult } from "./chat-retained-result.js";
import { readChatAlphaEditResult } from "./chat-alphaedit-result.js";
import { readChatNeuronTrainingResult } from "./chat-neuron-training-result.js";
import { chatResourceWorkspaces, chatTrainingAttachmentKey, ChatContextTargetSchema, type ChatContextOption, type ChatContextSelection, type ChatContextTarget, type ChatResourceSummary, type StoredExperimentDraftReference } from "@openpond/contracts";
import { createTrainingClient, canonicalJson, experimentOperationLabel, ExperimentDraftSaveSchema, type ExperimentDraft, type ExperimentDraftRecord } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { listHostedModelProjectCatalog } from "./hosted-model-project-catalog.js";
import { readChatHostedTrainingAttachment } from "./chat-hosted-training-attachment.js";
import { readChatTrainingAttachment } from "./chat-training-attachment.js";

import { createChatExperimentDraftStorage, storedDraftSelection } from "./chat-experiment-drafts.js";
import { chatSteeringExperiment } from "./chat-steering-experiment.js";
import { chatExperimentContext } from "./chat-experiment-scope.js";
import { readChatDecisionResult } from "./chat-decision-result.js";

type Access = { apiBaseUrl: string; token: string; teamId: string; actorId: string };
function focusKey(state: ReturnType<typeof chatExperimentContext>) {
  const scope = chatResourceWorkspaces(state).find(item => item.id === state.activeScopeId);
  return JSON.stringify([state.activeScopeId, scope?.dataset?.id ?? null, scope?.dataset?.revision ?? null,
    scope?.dataset?.owner ?? scope?.dataset?.profileRef ?? null, scope?.selectedRunId ?? null, scope?.selectedTrainingKey ?? null]);
}

export function createChatContextBrowser(deps: {
  store: SqliteStore; access: () => Promise<Access>;
  resources: () => Promise<ChatResourceSummary[]>;
  resource: (target: ChatContextTarget) => Promise<ChatResourceSummary>;
  selectResource: (sessionId: string, target: ChatContextTarget | null, version?: number) => Promise<void>;
  createExperiment: (sessionId: string, dataset: ChatContextTarget, expected?: { version: number; target: ChatContextTarget }) => Promise<void>;
  associateDraftTraining?: (sessionId: string, draftId: string, training: import("@openpond/contracts").ChatTrainingAttachment) => Promise<void>;
  createDraft?: (sessionId: string, draft: ExperimentDraft, expected: { version: number; target: ChatContextTarget | null }) => Promise<void>;
  linkStoredDraft?: (sessionId: string, record: ExperimentDraftRecord, reference: StoredExperimentDraftReference, expected?: { version: number; target: ChatContextTarget | null }, scopeId?: string) => Promise<void>;
  inspectResource?: (resource: ChatResourceSummary) => Promise<{ dataset?: ChatResourceSummary; graders?: ChatResourceSummary[] }>;

}) {
  const drafts = createChatExperimentDraftStorage(deps.access);
  async function catalog(refresh = true, sessionId?: string, draftCursor?: string) {
    const session = sessionId ? await deps.store.getSession(sessionId) : null;
    if (sessionId && (!session || session.systemKind)) throw new Error("Chat is unavailable.");
    const scopes = session ? chatExperimentContext(session.metadata).scopes : [];
    function storedOptions(items: ChatContextSelection[]): ChatContextOption[] {
      return items.map(({ target, label, detail }) => {
        const scope = scopes.find(item => item.storedDraft && canonicalJson(item.storedDraft) === canonicalJson({ id: target.id, teamId: target.teamId, apiOrigin: target.apiOrigin }));
        const selected: ChatContextTarget = scope ? { kind: "experiment", id: scope.id, scopeId: scope.id, sessionId, location: "local" } : target;
        return { target: selected, label, detail };
      });
    }
    if (draftCursor) {
      const stored = await drafts.list(draftCursor);
      return { options: storedOptions(stored.options), warning: null, nextDraftCursor: stored.page.nextCursor };
    }
    const resources = await deps.resources();
    const options: ChatContextOption[] = resources.filter(item => item.kind !== "grader").map(item => ({
      target: { kind: item.kind as "dataset" | "experiment", id: item.id, revision: item.revision, location: item.location ?? "local" },
      label: item.name, detail: item.kind === "dataset" ? `Dataset · revision ${item.revision}` : `${item.state} · Dataset revision ${item.datasetRevision ?? "—"} · ${item.model ?? ""} · ${item.id.slice(-8)}`,
    }));
    for (const model of await deps.store.listModelProjects()) options.push({
      target: { kind: "model", id: model.id, location: "local" }, label: model.name,
      detail: `Model · ${model.defaultBaseModel?.modelId ?? "Local"}`,
    });
    if (sessionId) {
      for (const scope of scopes.filter(scope => !scope.storedDraft && !scope.selectedRunId && (scope.dataset || scope.draft))) options.unshift({
        target: { kind: "experiment", id: scope.id, scopeId: scope.id, sessionId, location: "local" },
        label: scope.name, detail: scope.draft ? `Draft · ${experimentOperationLabel(scope.draft.operationType)}` : `Draft · ${scope.dataset!.name} · revision ${scope.dataset!.revision}`,
      });
    }
    let warning: string | null = null;
    try {
      const access = await deps.access();
      const hosted = await listHostedModelProjectCatalog({ store: deps.store, resolveAccess: async () => access, fetch }, { refresh });
      for (const { project } of hosted.projects) options.push({
        target: { kind: "model", id: project.id, location: "cloud", teamId: access.teamId, apiOrigin: new URL(access.apiBaseUrl).origin },
        label: project.name, detail: `Model · ${project.defaultBaseModel?.modelId ?? "Hosted"}`,
      });
    } catch { warning = "Hosted models could not be loaded for the current account. Local resources remain available."; }
    let nextDraftCursor: string | null = null;
    try {
      const stored = await drafts.list(draftCursor);
      nextDraftCursor = stored.page.nextCursor;
      options.unshift(...storedOptions(stored.options));
    } catch { warning = [warning, "Saved experiment drafts could not be loaded for the current account."].filter(Boolean).join(" "); }
    return { options, warning, nextDraftCursor };
  }
  async function modelDetails(target: ChatContextTarget) {
    const project = target.location === "local" ? await deps.store.getModelProject(target.id) : await (async () => {
      const access = await deps.access();
      if (target.teamId !== access.teamId || target.apiOrigin !== new URL(access.apiBaseUrl).origin) throw new Error("Model belongs to another account.");
      const listing = await listHostedModelProjectCatalog({ store: deps.store, resolveAccess: async () => access, fetch }, { refresh: false });
      return listing.projects.find(item => item.project.id === target.id)?.project;
    })();
    if (!project) throw new Error("Model is unavailable.");
    const dataset = async (ref: { id: string; revision: number } | null | undefined) => {
      if (!ref) return null;
      const record = await deps.store.readLocalDatasetListing(ref.id, ref.revision);
      return { id: ref.id, revision: ref.revision, name: record?.workspace.draft.name || ref.id };
    };
    const [trainingDataset, evaluationDataset] = await Promise.all([dataset(project.trainingSetup.tasksetRef), dataset(project.trainingSetup.evaluationTasksetRef)]);
    return { id: project.id, portableProjectId: "portableProjectId" in project ? project.portableProjectId : project.id,
      name: project.name, baseModel: project.defaultBaseModel?.modelId ?? null,
      trainingDataset, evaluationDataset };
  }
  async function resolve(raw: unknown): Promise<ChatContextSelection> {
    const target = ChatContextTargetSchema.parse(raw);
    if (["training_result", "managed_modification_result", "engram_result"].includes(target.kind)) return readChatRetainedResult(target, deps.access);
    if (target.kind === "alphaedit_result") return readChatAlphaEditResult(target, deps.access);
    if (target.kind === "neuron_training_result") return readChatNeuronTrainingResult(target, deps.access);
    if (target.kind === "decision_result") return readChatDecisionResult(target, deps.access);
    if (target.storedDraft) {
      const reference = { id: target.id, teamId: target.teamId!, apiOrigin: target.apiOrigin! };
      return storedDraftSelection(await drafts.read(reference), reference);
    }
    if (target.draft) return { target, draft: target.draft, label: target.draft.name, detail: "Experiment draft" };
    if (target.scopeId) {
      if (target.kind !== "experiment" || target.id !== target.scopeId || !target.sessionId || target.location !== "local") throw new Error("Invalid experiment draft.");
      const session = await deps.store.getSession(target.sessionId);
      if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "")) throw new Error("Chat is unavailable.");
      const scope = chatExperimentContext(session.metadata).scopes.find(scope => scope.id === target.scopeId);
      if (!scope || !scope.dataset && !scope.draft && !scope.storedDraft) throw new Error("Experiment draft is unavailable.");
      if (scope.storedDraft) {
        const selection = storedDraftSelection(await drafts.read(scope.storedDraft), scope.storedDraft);
        return { ...selection, target };
      }
      if (!scope.dataset) return { target, draft: scope.draft, draftRevision: scope.draftRevision ?? 1, label: scope.name, detail: "Experiment draft" };
      const resource = await deps.resource({ kind: "dataset", id: scope.dataset.id, revision: scope.dataset.revision, location: scope.dataset.location ?? "local" });
      if (resource.kind !== "dataset" || resource.id !== scope.dataset.id || resource.revision !== scope.dataset.revision ||
        (resource.location ?? "local") !== (scope.dataset.location ?? "local") ||
        JSON.stringify(resource.owner ?? null) !== JSON.stringify(scope.dataset.owner ?? null) ||
        JSON.stringify(resource.profileRef ?? null) !== JSON.stringify(scope.dataset.profileRef ?? null)) throw new Error("The draft’s exact dataset pin is unavailable.");
      return { target, draft: scope.draft, ...(scope.draft ? { draftRevision: scope.draftRevision ?? 1 } : {}), label: scope.name, detail: `Draft · ${resource.name}`, resource, ...await deps.inspectResource?.(resource) };
    }
    if (target.kind === "training") {
      const access = await deps.access();
      const training = target.location === "cloud"
        ? await readChatHostedTrainingAttachment(access, { jobId: target.id, teamId: target.teamId ?? "", apiOrigin: target.apiOrigin ?? "" })
        : await readChatTrainingAttachment(deps.store, { jobId: target.id }, access);
      const model = await modelDetails(training.location === "cloud"
        ? { kind: "model", id: training.job.modelProjectId, location: "cloud", teamId: training.owner.teamId, apiOrigin: training.apiOrigin }
        : { kind: "model", id: training.modelId, location: "local" });
      return { target, label: model.name, detail: training.location === "cloud" ? training.job.state : training.executionState, training, model };
    }
    if (target.kind === "model") {
      const model = await modelDetails(target);
      return { target, label: model.name, detail: `Model · ${model.baseModel ?? "Configured model"}`, model };
    }
    const resource = await deps.resource(target);
    if (resource.kind !== target.kind || resource.id !== target.id || (target.revision !== undefined && resource.revision !== target.revision)
      || (resource.location ?? "local") !== target.location) throw new Error("The selected resource revision is unavailable.");
    return { target: { ...target, revision: resource.revision }, label: resource.name, detail: resource.state, resource, ...await deps.inspectResource?.(resource) };
  }

  async function runs(raw: unknown) {
    const selected = await resolve(raw);
    if (!selected.model) throw new Error("Select a model to browse training runs.");
    const access = await deps.access();
    if (selected.target.location === "cloud") {
      const headers = hostedApiAuthHeaders(access.token); headers.set("x-openpond-team-id", access.teamId);
      const client = createTrainingClient({ baseUrl: access.apiBaseUrl, headers, fetch });
      const page = await client.listJobs({ modelProjectId: selected.target.id, limit: 100 });
      if (page.jobs.some(job => job.teamId !== access.teamId || job.modelProjectId !== selected.target.id)) throw new Error("Training history returned another model or workspace.");
      return page.jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => ({ target: { kind: "training" as const, id: job.id, location: "cloud" as const, teamId: access.teamId, apiOrigin: new URL(access.apiBaseUrl).origin },
        label: `${job.createdAt.slice(0, 16).replace("T", " ")} UTC · ${job.state === "succeeded" ? "Completed" : job.state}`, detail: `$${job.accruedSpendUsd.toFixed(4)} · ${job.id}` }));
    }
    const options: ChatContextOption[] = [];
    for (const job of (await deps.store.listTrainingJobs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const runId = job.metadata.modelRunId;
      const run = typeof runId === "string" ? await deps.store.getModelRun(runId) : null;
      if (run?.modelId !== selected.target.id) continue;
      try {
        const training = await readChatTrainingAttachment(deps.store, { jobId: job.id }, access);
        if (training.location !== "local" || training.modelId !== selected.target.id) continue;
        options.push({ target: { kind: "training", id: job.id, location: "local" }, label: `${job.createdAt.slice(0, 16)} · ${job.status}`, detail: job.id });
      } catch { /* Only canonical executions owned by this account are selectable. */ }
    }
    return options;
  }
  async function select(raw: unknown, sessionId?: string, newExperiment = false, sourceDraftId?: string) {
    let selection = raw === null ? null : await resolve(raw);
    if (sourceDraftId) {
      if (!sessionId || !selection?.training || !deps.associateDraftTraining || newExperiment)
        throw new Error("A returned training Job requires its originating chat draft.");
      const session = await deps.store.getSession(sessionId);
      const scope = chatExperimentContext(session?.metadata).scopes.find(item => item.draft?.id === sourceDraftId || item.storedDraft?.id === sourceDraftId);
      if (!scope) throw new Error("The originating experiment draft is not in this conversation.");
      if (scope.storedDraft) await drafts.read(scope.storedDraft);
      const active = await deps.access(), training = selection.training;
      if (training.owner.actorId !== active.actorId || training.owner.teamId !== active.teamId ||
        training.location === "cloud" && training.apiOrigin !== new URL(active.apiBaseUrl).origin)
        throw new Error("The active account changed before the training Job was associated.");
      await deps.associateDraftTraining(sessionId, sourceDraftId, selection.training);
      return current(sessionId);
    }
    if (newExperiment && selection?.target.kind === "model") {
      const draft = await chatSteeringExperiment(selection.target, deps.access);
      selection = { target: {kind:"experiment",id:draft.id,location:"local",draft}, draft, label:draft.name, detail:"Saved Model experiment draft" };
    }
    if (newExperiment && !selection?.draft && selection?.resource?.kind !== "dataset") throw new Error("Choose an experiment draft or dataset.");
    if (sessionId) {
      const session = await deps.store.getSession(sessionId);
      if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "")) throw new Error("This chat cannot select local resources.");
      if (selection?.storedDraft && selection.target.storedDraft) {
        if (!deps.linkStoredDraft) throw new Error("Stored experiment authoring is unavailable.");
        const state = chatExperimentContext(session.metadata);
        const reference = { id: selection.storedDraft.id, teamId: selection.target.teamId!, apiOrigin: selection.target.apiOrigin! };
        await deps.linkStoredDraft(sessionId, selection.storedDraft, reference, { version: state.selectionVersion,
          target: ChatContextTargetSchema.nullable().optional().parse(session.metadata?.chatContextSelection) ?? null });
        if (!newExperiment) {
          const linked = chatExperimentContext((await deps.store.getSession(sessionId))?.metadata);
          const scope = linked.scopes.find(item => item.storedDraft && canonicalJson(item.storedDraft) === canonicalJson(reference));
          if (scope && linked.activeScopeId !== scope.id) await deps.selectResource(sessionId, { kind: "experiment", id: scope.id, scopeId: scope.id, sessionId, location: "local" });
        }
        return current(sessionId);
      }
      if (selection?.target.draft) {
        if (!deps.createDraft) throw new Error("Experiment draft authoring is unavailable.");
        const state = chatExperimentContext(session.metadata);
        await deps.createDraft(sessionId, selection.target.draft, { version: state.selectionVersion,
          target: ChatContextTargetSchema.nullable().optional().parse(session.metadata?.chatContextSelection) ?? null });
        return current(sessionId);
      }
      if (newExperiment && selection) await deps.createExperiment(sessionId, selection.target);
      else if (selection?.target.scopeId) {
        if (selection.target.sessionId !== sessionId) throw new Error("This draft belongs to another chat.");
        await deps.selectResource(sessionId, selection.target);
      } else if (selection?.resource || !selection) await deps.selectResource(sessionId, selection?.target ?? null);
      const focused = await deps.store.getSession(sessionId);
      const state = chatExperimentContext(focused?.metadata);
      if (newExperiment && state.activeScopeId) selection = await resolve({ kind: "experiment", id: state.activeScopeId, scopeId: state.activeScopeId, sessionId, location: "local" });
      const version = state.selectionVersion;
      await deps.store.updateSession(sessionId, current => ({ ...current, metadata: { ...current.metadata,
        chatContextSelection: selection?.target ?? null, chatContextSelectionVersion: version, chatContextFocusKey: focusKey(state) } }));
    }
    return selection;
  }
  async function current(sessionId: string) {
    const session = await deps.store.getSession(sessionId);
    if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "")) throw new Error("Chat is unavailable.");
    const state = chatExperimentContext(session.metadata);
    const scope = chatResourceWorkspaces(state).find(item => item.id === state.activeScopeId);
    const saved = ChatContextTargetSchema.nullable().optional().parse(session.metadata?.chatContextSelection);
    const version = session.metadata?.chatContextSelectionVersion;
    const run = scope?.runs.find(item => item.id === scope.selectedRunId);
    const training = scope?.training?.find(item => chatTrainingAttachmentKey(item) === scope.selectedTrainingKey);
    const resource = run ?? scope?.dataset;
    const focused: ChatContextTarget | null = training ? {
      kind: "training", id: training.jobId, location: training.location,
      ...(training.location === "cloud" ? { teamId: training.owner.teamId, apiOrigin: training.apiOrigin } : {}),
    } : !run && scope?.ordinal && (scope.dataset || scope.draft || scope.storedDraft) ? { kind: "experiment", id: scope.id, scopeId: scope.id, sessionId, location: "local" }
      : resource ? { kind: resource.kind as "dataset" | "experiment", id: resource.id, revision: resource.revision, location: resource.location ?? "local" } : null;
    const sameFocus = session.metadata?.chatContextFocusKey === undefined || session.metadata.chatContextFocusKey === focusKey(state);
    // A draft staged before the first message is materialized in the newly
    // created chat, only while its exact staged target still owns selection.
    if (saved?.storedDraft) {
      if (scope || version !== undefined) return focused ? resolve(focused) : null;
      if (!deps.linkStoredDraft) throw new Error("Stored experiment authoring is unavailable.");
      const selected = await resolve(saved);
      const reference = { id: saved.id, teamId: saved.teamId!, apiOrigin: saved.apiOrigin! };
      await deps.linkStoredDraft(sessionId, selected.storedDraft!, reference, { version: state.selectionVersion, target: saved });
      return current(sessionId);
    }
    if (saved?.draft) {
      if (scope || version !== undefined) return focused ? resolve(focused) : null;
      if (!deps.createDraft) throw new Error("Experiment draft authoring is unavailable.");
      await deps.createDraft(sessionId, saved.draft, { version: state.selectionVersion, target: saved });
      const fresh = await deps.store.getSession(sessionId);
      if (canonicalJson(fresh?.metadata?.chatContextSelection ?? null) === canonicalJson(saved))
        throw new Error("The experiment draft could not be attached to this chat.");
      return current(sessionId);
    }
    if (version === state.selectionVersion && sameFocus) return saved ? resolve(saved) : null;
    if (version === undefined && saved && ["model", "training", "training_result", "managed_modification_result", "engram_result", "decision_result", "alphaedit_result", "neuron_training_result"].includes(saved.kind)) {
      await deps.store.updateSession(sessionId, current => {
        const target = ChatContextTargetSchema.safeParse(current.metadata?.chatContextSelection);
        if (current.metadata?.chatContextSelectionVersion !== undefined || !target.success ||
          JSON.stringify(target.data) !== JSON.stringify(saved) ||
          chatExperimentContext(current.metadata).selectionVersion !== state.selectionVersion) return current;
        return { ...current, metadata: { ...current.metadata, chatContextSelectionVersion: state.selectionVersion, chatContextFocusKey: focusKey(state) } };
      });
      return resolve(saved);
    }
    if (focused) return resolve(focused);
    if (saved?.kind === "dataset" && !scope) {
      await deps.createExperiment(sessionId, saved, { version: state.selectionVersion, target: saved });
      const created = chatExperimentContext((await deps.store.getSession(sessionId))?.metadata);
      if (!created.activeScopeId) throw new Error("The experiment draft was not created.");
      return resolve({ kind: "experiment", id: created.activeScopeId, scopeId: created.activeScopeId, sessionId, location: "local" });
    }
    if (saved?.kind === "experiment" && !scope) await deps.selectResource(sessionId, saved, state.selectionVersion);
    return saved ? resolve(saved) : null;
  }
  async function updateDraft(sessionId: string | undefined, rawTarget: unknown, rawInput: unknown) {
    const target = ChatContextTargetSchema.parse(rawTarget), input = ExperimentDraftSaveSchema.parse(rawInput);
    if (target.scopeId && target.sessionId !== sessionId) throw new Error("This experiment scope belongs to another chat.");
    const selected = await resolve(target);
    if (!selected.draft || selected.draft.id !== input.draft.id)
      throw new Error("Reopen the intended experiment before saving settings.");
    if (!selected.storedDraft && input.expectedRevision !== 0)
      throw new Error("An unsaved experiment requires revision zero.");
    const { receipt, reference } = await drafts.save(input);
    if (sessionId && target.scopeId) {
      if (!deps.linkStoredDraft) throw new Error("Stored experiment attachment is unavailable.");
      await deps.linkStoredDraft(sessionId, receipt.record, reference, undefined, target.scopeId);
    }
    const saved = storedDraftSelection(receipt.record, reference);
    if (target.scopeId) saved.target = target;
    // Preserve the exact receipt separately from current focus/state. An old
    // operation retry cannot report a newer draft as the input it saved.
    const currentSaved = await resolve(saved.target);
    return { saved, currentSaved, selection: sessionId ? await current(sessionId) : currentSaved };
  }
  return { catalog, resolve, runs, select, current, updateDraft };
}
