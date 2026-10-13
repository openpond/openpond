import { inlineErrorMessage } from "../../../lib/error-messages";
import { UnifiedGraderCollection } from "./UnifiedGraderCollection";
import { DropdownSelect } from "../../DropdownSelect";
import { GraderVersionsTable, GraderUsageTable } from "./GraderAssociationTables";
import { EvaluationCard } from "./EvaluationPresentation";
import { useWorkspaceActions } from "./WorkspacePanel";
import { GraderStarterChoices, type GraderStarter } from "./GraderStarterChoices";
import { useWorkspaceResourceName } from "./WorkspacePanel";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GraderCatalogPageSchema, GraderVersionsPageSchema, GraderUsagePageSchema } from "openpond-sdk/learning";
import type { z } from "zod";
import { WorkspacePanel } from "./WorkspacePanel";
import { useMemo, useRef, useState } from "react";
import { OpenPondLearningClient, type AuthoringDraft, type RewardRelease, learningRef } from "openpond-sdk/learning";
import { scopeLearningClient } from "../../../lib/query-scope";
import { useLearningResource } from "../learning/useLearningResources";
import { RewardEditor, type GraderModelChoice } from "../learning/RewardEditor";
import { RewardCheckHistory } from "../learning/RewardCheckHistory";
import { AuthoringDraftList } from "../learning/AuthoringDraftList";
import { AuthoringDraftEditor } from "../learning/AuthoringDraftEditor";
import type { DraftEditorHandle } from "../useDraftNavigation";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function HostedGradersPage({ api, inventory, route, navigate }: { api: WorkspaceApi; inventory?: Inventory | null; route: ModelsRoute; navigate: (route: ModelsRoute) => void }) {
  const client = useMemo(() => scopeLearningClient(new OpenPondLearningClient({ baseUrl: "https://desktop.openpond.invalid", apiKey: "desktop-server-boundary", scope: api.teamId, fetch: async (url, init) => {
    const endpoint = new URL(String(url)).pathname.split("/").at(-1);
    if (endpoint !== "read" && endpoint !== "commands") throw new Error("Unsupported grader action.");
    const result = await api.request("learningRelay", { endpoint, request: JSON.parse(String(init?.body)) }, init?.signal ?? undefined);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } }), ["learning", "hosted-evaluation-workspace", api.key]), [api]);
  const queries = useQueryClient();
  const refresh = () => { void queries.invalidateQueries({ queryKey: ["evaluation-workspace", api.key] }); };
  const selected = useLearningResource(client, "reward", route.resourceId, route.revision);
  const [starter, setStarter] = useState<GraderStarter | null>(null);
  const [editing, setEditing] = useState<RewardRelease | "new" | null>(null);
  const [resuming, setResuming] = useState<AuthoringDraft | null>(null);
  const closeRef = useRef<DraftEditorHandle>(null);
  const [beforeRevision, setBeforeRevision] = useState<number | undefined>();
  const [usageAfter, setUsageAfter] = useState<string | undefined>();
  const [section, setSection] = useState<"projects" | "datasets" | "runs">("datasets");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("name");
  const graderModels = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderModels"], enabled: Boolean(editing || resuming), queryFn: ({ signal }) => api.request<{ models: GraderModelChoice[] }>("graderModels", undefined, signal) });
  const catalog = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderCatalog", route.query, kind, sort, route.after], queryFn: ({ signal }) => api.request<z.infer<typeof GraderCatalogPageSchema>>("graderCatalog", { search: route.query, kind, sort, ...(route.after ? { after: route.after } : {}) }, signal) });
  const versions = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderVersions", route.resourceId, beforeRevision], enabled: Boolean(route.resourceId), queryFn: ({ signal }) => api.request<z.infer<typeof GraderVersionsPageSchema>>("graderVersions", { id: route.resourceId, ...(beforeRevision === undefined ? {} : { beforeRevision }) }, signal) });
  const usage = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderUsage", route.resourceId, section, usageAfter], enabled: Boolean(route.resourceId && route.detailTab === "usage"), queryFn: ({ signal }) => api.request<z.infer<typeof GraderUsagePageSchema>>("graderUsage", { id: route.resourceId, query: { section, ...(usageAfter ? { after: usageAfter } : {}) } }, signal) });
  const pinError = selected.resource && route.contentHash && selected.resource.contentHash !== route.contentHash ? "Grader differs from its pinned release." : null;
  const entry = pinError ? null : selected.resource;
  const selectSidebarAction = useWorkspaceActions([{ id: "grader", label: "Grader", onSelect: () => { if (!editing && !resuming) { setStarter(null); setEditing(entry ?? "new"); } } }]);
  const tab = route.detailTab ?? "overview";
  useWorkspaceResourceName(entry?.name ?? (selected.error ? "Unavailable grader" : null));
  return <>
    <header className="evaluation-workspace-header"><h1>{entry?.name ?? "Graders"}</h1>{!entry ? <><input aria-label="Search graders" placeholder="Search graders" value={route.query} onChange={event => navigate({ ...route, query: event.target.value, after: null })} /><DropdownSelect label="Grader type" value={kind} onChange={value => { setKind(value); navigate({ ...route, after: null }); }} options={[
      {value:"",label:"All types"}, ...[["model_judge","LLM judge"],["custom_verifier","JavaScript verifier"],["state","Exact fields"],["content","Text answer"],["schema","Output schema"],["artifact","Artifact reference"],["runtime_event","Runtime events"],["human","Human review"],["learned_model","Learned reward model"]].map(([value,label])=>({value:value!,label:label!}))]} /></> : null}<button className="training-button" onClick={() => selectSidebarAction("grader")}>{entry ? "Publish update" : "+ Grader"}</button></header>
    {graderModels.error && inlineErrorMessage(graderModels.error) && (editing || resuming) ? <p role="alert">{graderModels.error.message}</p> : null}
    {inlineErrorMessage(selected.error ?? pinError) ? <p role="alert">{selected.error ?? pinError}</p> : null}

    {entry ? <><nav className="evaluation-workspace-tabs" aria-label="Grader tabs">{["overview", "checks", "usage", "versions"].map(value => <button key={value} aria-selected={tab === value} onClick={() => navigate({ ...route, detailTab: value })}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
      {tab === "checks" ? <RewardCheckHistory client={client} targetId={entry.id} draft={null} unchanged={false} busy={false} published={learningRef(entry)} readOnly /> : tab === "versions" ? <><GraderVersionsTable items={versions.data?.items ?? []} loading={versions.isPending} error={versions.error?.message} retry={()=>void versions.refetch()} onSelect={item=>navigate({...route,revision:item.revision,contentHash:item.contentHash,detailTab:"overview"})}/>{beforeRevision ? <button onClick={() => setBeforeRevision(undefined)}>Newest versions</button> : null}{versions.data?.nextRevision ? <button onClick={() => setBeforeRevision(versions.data!.nextRevision!)}>Older versions</button> : null}</> : tab === "usage" ? <><DropdownSelect label="Grader usage" value={section} onChange={value => { setSection(value as typeof section); setUsageAfter(undefined); }} options={["projects","datasets","runs"].map(value=>({value,label:value[0]!.toUpperCase()+value.slice(1)}))} /><GraderUsageTable items={usage.data?.items ?? []} loading={usage.isPending} error={usage.error?.message} retry={()=>void usage.refetch()}/>{usageAfter ? <button onClick={() => setUsageAfter(undefined)}>First usage page</button> : null}{usage.data?.nextCursor ? <button onClick={() => setUsageAfter(usage.data!.nextCursor!)}>More usage</button> : null}</> : <><EvaluationCard title="Grader release"><dl className="evaluation-workspace-meta"><dt>Release</dt><dd>{entry.id} · Revision {entry.revision}</dd><dt>Feedback</dt><dd>{entry.feedbackKey}</dd><dt>Version</dt><dd>{entry.revision}</dd><dt>Content hash</dt><dd>{entry.contentHash}</dd></dl></EvaluationCard><EvaluationCard title="Implementation"><pre>{JSON.stringify(entry.implementation, null, 2)}</pre></EvaluationCard></>}
    </> : <><DropdownSelect label="Sort graders" value={sort} onChange={value => { setSort(value); navigate({ ...route, after: null }); }} options={["name","type","version","projects","datasets","runs"].map(value=>({value,label:value[0]!.toUpperCase()+value.slice(1)}))} />{catalog.error && inlineErrorMessage(catalog.error) ? <p role="alert">{catalog.error.message}</p> : null}<UnifiedGraderCollection api={api} inventory={inventory} route={route} navigate={navigate} items={catalog.data?.items ?? []}
      loading={catalog.isPending} error={catalog.error?.message} retry={() => void catalog.refetch()} kind={kind} sort={sort} />{catalog.data?.nextCursor ? <button onClick={() => navigate({ ...route, after: catalog.data!.nextCursor })}>More graders</button> : null}</>}
    {!route.resourceId ? <AuthoringDraftList client={client} targetKind="reward" onResume={setResuming} /> : null}
    {editing || resuming ? <WorkspacePanel label="Grader editor" action="grader" onRequestClose={() => { if (closeRef.current) closeRef.current.requestClose(); else { setEditing(null); setResuming(null); } }}><header><h2>{entry ? "Publish update" : "Create grader"}</h2></header>{resuming ? <AuthoringDraftEditor embedded models={graderModels.data?.models ?? []} closeRef={closeRef} client={client} draft={resuming} onClose={() => setResuming(null)} onPublished={id => { setResuming(null); refresh(); navigate({ ...route, resourceId: id, detailTab: "overview" }); }} /> : editing === "new" && !starter ? <GraderStarterChoices onSelect={setStarter} /> : <RewardEditor embedded models={graderModels.data?.models ?? []} initialFields={starter ?? undefined} closeRef={closeRef} allowedKinds={["custom_verifier", "state", "content", "schema", "artifact", "runtime_event", "model_judge", "human"]} client={client} reward={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reward => { setEditing(null); refresh(); navigate({ ...route, resourceId: reward.id, revision: reward.revision, contentHash: reward.contentHash, detailTab: "overview" }); }} />}</WorkspacePanel> : null}
  </>;
}
