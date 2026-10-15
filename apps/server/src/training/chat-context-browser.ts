import { ChatContextTargetSchema, type ChatContextOption, type ChatContextSelection, type ChatContextTarget, type ChatResourceSummary } from "@openpond/contracts";
import { createTrainingClient } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { listHostedModelProjectCatalog } from "./hosted-model-project-catalog.js";
import { readChatHostedTrainingAttachment } from "./chat-hosted-training-attachment.js";
import { readChatTrainingAttachment } from "./chat-training-attachment.js";

type Access = { apiBaseUrl: string; token: string; teamId: string; actorId: string };
export function createChatContextBrowser(deps: {
  store: SqliteStore; access: () => Promise<Access>;
  resources: () => Promise<ChatResourceSummary[]>;
  selectResource: (sessionId: string, target: ChatContextTarget | null) => Promise<void>;
}) {
  async function catalog(refresh = true) {
    const resources = await deps.resources();
    const options: ChatContextOption[] = resources.filter(item => item.kind !== "grader").map(item => ({
      target: { kind: item.kind as "dataset" | "experiment", id: item.id, revision: item.revision, location: item.location ?? "local" },
      label: item.name, detail: item.kind === "dataset" ? `Dataset · revision ${item.revision}` : `Experiment · ${item.model ?? item.state}`,
    }));
    for (const model of await deps.store.listModelProjects()) options.push({
      target: { kind: "model", id: model.id, location: "local" }, label: model.name,
      detail: `Model · ${model.defaultBaseModel?.modelId ?? "Local"}`,
    });
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
  async function resolve(raw: unknown): Promise<ChatContextSelection> {
    const target = ChatContextTargetSchema.parse(raw);
    if (target.kind === "training") {
      const access = await deps.access();
      const training = target.location === "cloud"
        ? await readChatHostedTrainingAttachment(access, { jobId: target.id, teamId: target.teamId ?? "", apiOrigin: target.apiOrigin ?? "" })
        : await readChatTrainingAttachment(deps.store, { jobId: target.id }, access);
      return { target, label: `Training run ${target.id.slice(-8)}`, detail: training.location === "cloud" ? training.job.state : training.executionState, training };
    }
    const listing = await catalog(false);
    const option = listing.options.find(item => item.target.kind === target.kind && item.target.id === target.id
      && item.target.location === target.location && item.target.teamId === target.teamId);
    if (!option) throw new Error("This resource is unavailable in the selected account.");
    if (target.kind === "model") {
      if (target.location === "local") {
        const project = await deps.store.getModelProject(target.id);
        if (!project) throw new Error("Model is unavailable.");
        return { ...option, model: { id: project.id, portableProjectId: project.id, name: project.name, baseModel: project.defaultBaseModel?.modelId ?? null } };
      }
      return { ...option, model: { id: target.id, portableProjectId: target.id, name: option.label, baseModel: null } };
    }
    const resource = (await deps.resources()).find(item => item.kind === target.kind && item.id === target.id && (!target.revision || item.revision === target.revision));
    if (!resource) throw new Error("The selected resource revision is unavailable.");
    return { ...option, target, resource };
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
      return page.jobs.map(job => ({ target: { kind: "training" as const, id: job.id, location: "cloud" as const, teamId: access.teamId, apiOrigin: new URL(access.apiBaseUrl).origin },
        label: `${job.createdAt.slice(0, 16).replace("T", " ")} UTC · ${job.state === "succeeded" ? "Completed" : job.state}`, detail: `$${job.accruedSpendUsd.toFixed(4)} · ${job.id}` }));
    }
    const options: ChatContextOption[] = [];
    for (const job of await deps.store.listTrainingJobs()) {
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
  async function select(raw: unknown, sessionId?: string) {
    const selection = raw === null ? null : await resolve(raw);
    if (sessionId) {
      const session = await deps.store.getSession(sessionId);
      if (!session || session.systemKind || ["sandbox", "sandbox_template"].includes(session.workspaceKind ?? "")) throw new Error("This chat cannot select local resources.");
      if (selection?.resource || !selection) await deps.selectResource(sessionId, selection?.target ?? null);
      await deps.store.updateSession(sessionId, current => ({ ...current, metadata: { ...current.metadata, chatContextSelection: selection?.target ?? null } }));
    }
    return selection;
  }
  return { catalog, resolve, runs, select };
}
