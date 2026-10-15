import { chatResourceWorkspaces, chatTrainingAttachmentKey, ChatContextTargetSchema, type ChatContextOption, type ChatContextSelection, type ChatContextTarget, type ChatResourceSummary } from "@openpond/contracts";
import { createTrainingClient } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { listHostedModelProjectCatalog } from "./hosted-model-project-catalog.js";
import { readChatHostedTrainingAttachment } from "./chat-hosted-training-attachment.js";
import { readChatTrainingAttachment } from "./chat-training-attachment.js";

import { chatExperimentContext } from "./chat-experiment-scope.js";

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
  inspectResource?: (resource: ChatResourceSummary) => Promise<{ dataset?: ChatResourceSummary; graders?: ChatResourceSummary[] }>;

}) {
  async function catalog(refresh = true, sessionId?: string) {
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
      const session = await deps.store.getSession(sessionId);
      if (!session || session.systemKind) throw new Error("Chat is unavailable.");
      for (const scope of chatExperimentContext(session.metadata).scopes.filter(scope => !scope.selectedRunId && scope.dataset)) options.unshift({
        target: { kind: "experiment", id: scope.id, scopeId: scope.id, sessionId, location: "local" },
        label: scope.name, detail: `Draft · ${scope.dataset!.name} · revision ${scope.dataset!.revision}`,
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
    return { options, warning };
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
    if (target.scopeId) {
      if (target.kind !== "experiment" || target.id !== target.scopeId || !target.sessionId || target.location !== "local") throw new Error("Invalid experiment draft.");
      const session = await deps.store.getSession(target.sessionId);
      if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "")) throw new Error("Chat is unavailable.");
      const scope = chatExperimentContext(session.metadata).scopes.find(scope => scope.id === target.scopeId);
      if (!scope?.dataset) throw new Error("Experiment draft is unavailable.");
      const resource = await deps.resource({ kind: "dataset", id: scope.dataset.id, revision: scope.dataset.revision, location: scope.dataset.location ?? "local" });
      if (resource.kind !== "dataset" || resource.id !== scope.dataset.id || resource.revision !== scope.dataset.revision ||
        (resource.location ?? "local") !== (scope.dataset.location ?? "local") ||
        JSON.stringify(resource.owner ?? null) !== JSON.stringify(scope.dataset.owner ?? null) ||
        JSON.stringify(resource.profileRef ?? null) !== JSON.stringify(scope.dataset.profileRef ?? null)) throw new Error("The draft’s exact dataset pin is unavailable.");
      return { target, label: scope.name, detail: `Draft · ${resource.name}`, resource, ...await deps.inspectResource?.(resource) };
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
  async function select(raw: unknown, sessionId?: string, newExperiment = false) {
    let selection = raw === null ? null : await resolve(raw);
    if (newExperiment && selection?.resource?.kind !== "dataset") throw new Error("Choose the dataset for this experiment.");
    if (sessionId) {
      const session = await deps.store.getSession(sessionId);
      if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "")) throw new Error("This chat cannot select local resources.");
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
    } : !run && scope?.ordinal && scope.dataset ? { kind: "experiment", id: scope.id, scopeId: scope.id, sessionId, location: "local" }
      : resource ? { kind: resource.kind as "dataset" | "experiment", id: resource.id, revision: resource.revision, location: resource.location ?? "local" } : null;
    const sameFocus = session.metadata?.chatContextFocusKey === undefined || session.metadata.chatContextFocusKey === focusKey(state);
    if (version === state.selectionVersion && sameFocus) return saved ? resolve(saved) : null;
    if (version === undefined && saved && ["model", "training"].includes(saved.kind)) {
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
  return { catalog, resolve, runs, select, current };
}
