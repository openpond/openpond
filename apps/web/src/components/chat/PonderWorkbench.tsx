import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChatContextSelectionSchema, type ChatResourceSummary, type ChatContextTarget, type Taskset } from "@openpond/contracts";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ClientConnection } from "../../api";
import { chatResourceRequest } from "../../api/chat-resource-api";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { DropdownSelect } from "../DropdownSelect";
import { requestDesktopViewChange } from "../labs/lab-primary-tab-state";
import { ErrorToast } from "../common/ErrorToast";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { datasetWorkspaceContext } from "./dataset-workspace-data";
import { PonderDatasetTasks } from "./PonderDatasetTasks";
import { PonderGraderInspector } from "./PonderGraderInspector";
import { PonderSavedTaskset } from "./PonderSavedTaskset";
import { PonderHostedDataset } from "./PonderHostedDataset";

type Context = ReturnType<typeof useChatContextSelection>;
type Tab = "model" | "dataset" | "graders";
const rememberedTabs = new Map<string, Tab>();
type Input = { role: string; name: string; dataset?: ChatResourceSummary; taskset?: Pick<Taskset, "id" | "profileId" | "name" | "revision" | "contentHash" | "tasks" | "graders">; release?: DatasetPopulationPage["release"] };
export function PonderWorkbench({ context, connection, sessionId, resources, children }: {
  context: Context; connection: ClientConnection; sessionId: string | null; resources: ReturnType<typeof useChatResourceFocus>; children: ReactNode;
}) {
  const tabKey = `${context.scope}:${JSON.stringify(context.selection?.target ?? null)}`;
  const defaultTab: Tab = context.selection?.target.kind === "dataset" ? "dataset" : "model";
  const [tabState, setTabState] = useState(() => ({ key: tabKey, value: rememberedTabs.get(tabKey) ?? defaultTab }));
  const tab = tabState.key === tabKey ? tabState.value : rememberedTabs.get(tabKey) ?? defaultTab;
  const setTab = (value: Tab) => setTabState({ key: tabKey, value });
  useEffect(() => {
    if (rememberedTabs.size >= 128 && !rememberedTabs.has(tabKey)) rememberedTabs.delete(rememberedTabs.keys().next().value!);
    rememberedTabs.set(tabKey, tab);
  }, [tabKey, tab]);
  const id = useId();
  const tabs = [{ value: "model", label: "Model / Experiments" }, { value: "dataset", label: "Dataset" }, { value: "graders", label: "Graders" }] as const;
  return <>
    <div className="workspace-diff-tabs ponder-workbench-tabs" role="tablist" aria-label="Ponder Training views">
      {tabs.map((item, index) => <button key={item.value} type="button" role="tab" id={`${id}-${item.value}`} aria-controls={`${id}-panel`}
        aria-selected={tab === item.value} tabIndex={tab === item.value ? 0 : -1} className={`workspace-diff-tab${tab === item.value ? " active" : ""}`}
        onClick={() => void requestDesktopViewChange(() => setTab(item.value))} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); void requestDesktopViewChange(() => { setTab(tabs[next]!.value); document.getElementById(`${id}-${tabs[next]!.value}`)?.focus(); }); }
        }}>{item.label}</button>)}
    </div>
    <div className="ponder-workbench-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === "model" ? children : <PonderInputs key={`${context.scope}:${JSON.stringify(context.selection?.target)}`} context={context}
        connection={connection} sessionId={sessionId} resources={resources} tab={tab} />}
    </div>
  </>;
}

function PonderInputs({ context, connection, sessionId, resources, tab }: {
  context: Context; connection: ClientConnection; sessionId: string | null; resources: ReturnType<typeof useChatResourceFocus>; tab: "dataset" | "graders";
}) {
  const scope = useContext(ChatExperimentWorkspaceContext);
  const api = useMemo(() => scope?.teamId && scope.actorId ? createWorkspaceApi(connection, { ...scope, teamId: scope.teamId, actorId: scope.actorId, projectId: null }) : null,
    [connection, scope?.accountKey, scope?.actorId, scope?.teamId]);
  const [role, setRole] = useState("training");
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection;
  const modelTarget: ChatContextTarget | null = selected?.training ? selected.training.location === "cloud"
    ? { kind: "model", id: selected.training.job.modelProjectId, location: "cloud", teamId: selected.training.owner.teamId, apiOrigin: selected.training.apiOrigin }
    : { kind: "model", id: selected.training.modelId, location: "local" }
    : selected?.model ? selected.target : null;
  const modelInputs = useQuery({ queryKey: ["ponder-model-inputs", context.scope, modelTarget], enabled: Boolean(modelTarget), staleTime: 30_000,
    queryFn: ({ signal }) => chatResourceRequest<{ sources: Input[] }>(connection, "dataset", { action: "context_inputs", payload: { target: modelTarget } }, signal) });
  const input = modelInputs.data?.sources.find(item => item.role === role) ?? modelInputs.data?.sources[0];
  const dataset = modelTarget ? input?.dataset : selected?.dataset ?? (selected?.resource?.kind === "dataset" ? selected.resource : null);
  const details = useQuery({ queryKey: ["ponder-input-details", context.scope, dataset?.id, dataset?.revision], enabled: Boolean(dataset && !dataset.owner && !dataset.profileRef), staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const value = await chatResourceRequest<{ selection: unknown }>(connection, "dataset", { action: "context_resolve", payload: { target: { kind: "dataset", id: dataset!.id, revision: dataset!.revision, location: "local" } } }, signal);
      return ChatContextSelectionSchema.parse(value.selection);
    } });
  const choices = (context.catalog.data?.options ?? []).filter(item => item.target.kind === "dataset");
  const contexts = modelTarget ? [] : datasetWorkspaceContext(resources);
  const value = dataset ? JSON.stringify({ kind: "dataset", id: dataset.id, revision: dataset.revision, location: dataset.location ?? "local" }) : "";
  const options = choices.map(item => ({ value: JSON.stringify(item.target), label: item.label, description: `${item.target.location === "cloud" ? "Hosted" : "Local"} · ${item.detail}` }));
  if (dataset && !options.some(item => item.value === value)) options.unshift({ value, label: dataset.name, description: `Revision ${dataset.revision}` });
  let hostedEditor: string | undefined;
  if (scope?.webBaseUrl) {
    const url = new URL("/console/graders", scope.webBaseUrl);
    if (scope.teamId) url.searchParams.set("teamId", scope.teamId);
    hostedEditor = url.toString();
  }
  async function choose(raw: string) {
    setError(null);
    try { await context.select(JSON.parse(raw), { newExperiment: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not select dataset."); }
  }
  return <div className="chat-experiment-tool-content ponder-workbench-content">
    <ErrorToast error={error ?? modelInputs.error ?? details.error}>
      {modelInputs.error || details.error ? <button type="button" className="training-button secondary" onClick={() => void Promise.all([modelInputs.refetch(), details.refetch()])}>Retry inputs</button> : null}
    </ErrorToast>
    {modelTarget && modelInputs.data?.sources.length ? <DropdownSelect label="Model dataset" floating value={input!.role}
      options={modelInputs.data.sources.map(item => ({ value: item.role, label: `${item.role === "training" ? "Training" : "Evaluation"} · ${item.name}` }))} onChange={value => void requestDesktopViewChange(() => setRole(value))} /> : null}
    {!modelTarget ? <DropdownSelect label="Experiment dataset" floating searchable disabled={context.selecting} value={value}
      options={[{ value: "", label: context.catalog.isPending ? "Loading datasets…" : "Choose dataset", disabled: true }, ...options]} onChange={raw => void choose(raw)} /> : null}
    {tab === "graders" && hostedEditor && !dataset && !input?.release ? <a className="training-text-button" href={hostedEditor} target="_blank" rel="noreferrer">Hosted grader editor</a> : null}
    {modelInputs.isPending && modelTarget ? <p role="status">Loading model inputs…</p> : null}
    {input?.taskset ? <PonderSavedTaskset key={`${input.taskset.id}:${input.taskset.revision}`} connection={connection} taskset={input.taskset} tab={tab} /> : input?.release && api ? <PonderHostedDataset key={JSON.stringify(input.release)} api={api} release={input.release} tab={tab} hostedEditor={hostedEditor} />
      : dataset && !dataset.owner && !dataset.profileRef ? tab === "dataset" ? <PonderDatasetTasks key={`${dataset.id}:${dataset.revision}`} connection={connection} dataset={dataset} sessionId={sessionId} contexts={contexts}
        onSaved={async saved => { await context.select({ kind: "dataset", id: saved.id, revision: saved.revision, location: "local" }, { newExperiment: true });  }} />
        : <PonderGraderInspector key={`${dataset.id}:${dataset.revision}`} connection={connection} dataset={dataset} graders={details.data?.graders ?? selected?.graders ?? []} sessionId={sessionId} contexts={contexts} hostedEditor={hostedEditor} />
        : !modelInputs.isPending || !modelTarget ? <p>{modelTarget ? "No dataset configured for this model. Ask chat to attach a dataset or open an experiment to choose its inputs." : "Choose a dataset to work on its tasks and graders."}</p> : null}
  </div>;
}
