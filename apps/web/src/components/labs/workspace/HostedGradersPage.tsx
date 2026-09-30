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
import { RewardEditor } from "../learning/RewardEditor";
import { RewardCheckHistory } from "../learning/RewardCheckHistory";
import { AuthoringDraftList } from "../learning/AuthoringDraftList";
import { AuthoringDraftEditor } from "../learning/AuthoringDraftEditor";
import type { DraftEditorHandle } from "../useDraftNavigation";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function HostedGradersPage({ api, route, navigate }: { api: WorkspaceApi; route: ModelsRoute; navigate: (route: ModelsRoute) => void }) {
  const client = useMemo(() => scopeLearningClient(new OpenPondLearningClient({ baseUrl: "https://desktop.openpond.invalid", apiKey: "desktop-server-boundary", scope: api.teamId, fetch: async (url, init) => {
    const endpoint = new URL(String(url)).pathname.split("/").at(-1);
    if (endpoint !== "read" && endpoint !== "commands") throw new Error("Unsupported grader action.");
    const result = await api.request("learningRelay", { endpoint, request: JSON.parse(String(init?.body)) }, init?.signal ?? undefined);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } }), ["learning", "hosted-evaluation-workspace", api.key]), [api]);
  const queries = useQueryClient();
  const refresh = () => { void queries.invalidateQueries({ queryKey: ["evaluation-workspace", api.key] }); };
  const selected = useLearningResource(client, "reward", route.resourceId);
  const [starter, setStarter] = useState<GraderStarter | null>(null);
  const [editing, setEditing] = useState<RewardRelease | "new" | null>(null);
  const [resuming, setResuming] = useState<AuthoringDraft | null>(null);
  const closeRef = useRef<DraftEditorHandle>(null);
  const [beforeRevision, setBeforeRevision] = useState<number | undefined>();
  const [usageAfter, setUsageAfter] = useState<string | undefined>();
  const [retainedVersions, setRetainedVersions] = useState<RewardRelease[]>([]);
  const [revision, setRevision] = useState<number | undefined>();
  const [section, setSection] = useState<"projects" | "datasets" | "runs">("datasets");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("name");
  const catalog = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderCatalog", route.query, kind, sort, route.after], queryFn: ({ signal }) => api.request<z.infer<typeof GraderCatalogPageSchema>>("graderCatalog", { search: route.query, kind, sort, ...(route.after ? { after: route.after } : {}) }, signal) });
  const versions = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderVersions", route.resourceId, beforeRevision], enabled: Boolean(route.resourceId), queryFn: ({ signal }) => api.request<z.infer<typeof GraderVersionsPageSchema>>("graderVersions", { id: route.resourceId, ...(beforeRevision === undefined ? {} : { beforeRevision }) }, signal) });
  const usage = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderUsage", route.resourceId, section, usageAfter], enabled: Boolean(route.resourceId && route.detailTab === "usage"), queryFn: ({ signal }) => api.request<z.infer<typeof GraderUsagePageSchema>>("graderUsage", { id: route.resourceId, query: { section, ...(usageAfter ? { after: usageAfter } : {}) } }, signal) });
  const entry = retainedVersions.find(item => item.revision === revision) ?? versions.data?.items.find(item => item.revision === revision) ?? selected.resource;
  const selectSidebarAction = useWorkspaceActions([{ id: "grader", label: "Grader", onSelect: () => { if (!editing && !resuming) { setStarter(null); setEditing(selected.resource ?? "new"); } } }]);
  const tab = route.detailTab ?? "overview";
  useWorkspaceResourceName(entry?.name ?? (selected.error ? "Unavailable grader" : null));
  return <>
    <header className="evaluation-workspace-header"><h1>{entry?.name ?? "Graders"}</h1>{!entry ? <><input aria-label="Search graders" placeholder="Search graders" value={route.query} onChange={event => navigate({ ...route, query: event.target.value, after: null })} /><select aria-label="Grader type" value={kind} onChange={event => { setKind(event.target.value); navigate({ ...route, after: null }); }}><option value="">All types</option>{[["model_judge", "LLM judge"], ["custom_verifier", "JavaScript verifier"], ["state", "Exact fields"], ["content", "Text answer"], ["schema", "Output schema"], ["artifact", "Artifact reference"], ["runtime_event", "Runtime events"], ["human", "Human review"], ["learned_model", "Learned reward model"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></> : null}<button className="training-button" onClick={() => selectSidebarAction("grader")}>{entry ? "Publish update" : "+ Grader"}</button></header>
    {selected.error ? <p role="alert">{selected.error}</p> : null}
    {catalog.isPending ? <p role="status">Loading graders…</p> : null}
    {entry ? <><nav className="evaluation-workspace-tabs" aria-label="Grader tabs">{["overview", "checks", "usage", "versions"].map(value => <button key={value} aria-selected={tab === value} onClick={() => navigate({ ...route, detailTab: value })}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
      {tab === "checks" ? <RewardCheckHistory client={client} targetId={entry.id} draft={null} unchanged={false} busy={false} published={learningRef(entry)} readOnly /> : tab === "versions" ? <>{versions.error ? <p role="alert">{versions.error.message}</p> : null}{versions.isPending ? <p role="status">Loading versions…</p> : null}<ul>{versions.data?.items.map(item => <li key={item.revision}><button className="training-text-button" onClick={() => { setRetainedVersions(previous => [...previous.filter(value => value.revision !== item.revision), item]); setRevision(item.revision); navigate({ ...route, detailTab: "overview" }); }}>Revision {item.revision} · {item.contentHash}</button></li>)}</ul>{beforeRevision ? <button onClick={() => setBeforeRevision(undefined)}>Newest versions</button> : null}{versions.data?.nextRevision ? <button onClick={() => setBeforeRevision(versions.data!.nextRevision!)}>Older versions</button> : null}</> : tab === "usage" ? <><label>Usage in <select value={section} onChange={event => { setSection(event.target.value as typeof section); setUsageAfter(undefined); }}>{["projects", "datasets", "runs"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{usage.error ? <p role="alert">{usage.error.message}</p> : null}<ul>{usage.data?.items.map(item => <li key={item.id}>{item.name} {"graderRevisions" in item ? `· Revisions ${item.graderRevisions.join(", ")}` : "status" in item ? `· ${item.status}` : ""}</li>)}</ul>{usageAfter ? <button onClick={() => setUsageAfter(undefined)}>First usage page</button> : null}{usage.data?.nextCursor ? <button onClick={() => setUsageAfter(usage.data!.nextCursor!)}>More usage</button> : null}{usage.data?.items.length === 0 ? <p>No retained usage in this section.</p> : null}</> : <><EvaluationCard title="Grader release"><dl className="evaluation-workspace-meta"><dt>Release</dt><dd>{entry.id} · Revision {entry.revision}</dd><dt>Feedback</dt><dd>{entry.feedbackKey}</dd><dt>Version</dt><dd>{entry.revision}</dd><dt>Content hash</dt><dd>{entry.contentHash}</dd></dl></EvaluationCard><EvaluationCard title="Implementation"><pre>{JSON.stringify(entry.implementation, null, 2)}</pre></EvaluationCard></>}
    </> : <><label>Sort <select value={sort} onChange={event => setSort(event.target.value)}>{["name", "type", "version", "projects", "datasets", "runs"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{catalog.error ? <p role="alert">{catalog.error.message}</p> : null}<table className="training-data-table evaluation-workspace-table"><thead><tr><th>Grader</th><th>Feedback key</th><th>Version</th><th>Revision</th></tr></thead><tbody>{catalog.data?.items.map(({ reward: item }) => <tr key={item.id} tabIndex={0} onClick={() => navigate({ ...route, resourceId: item.id })} onKeyDown={event => { if (event.key === "Enter") navigate({ ...route, resourceId: item.id }); }}><td>{item.name}</td><td>{item.feedbackKey}</td><td>{item.revision}</td><td>{item.revision}</td></tr>)}</tbody></table>{catalog.data?.nextCursor ? <button onClick={() => navigate({ ...route, after: catalog.data!.nextCursor })}>More graders</button> : null}</>}
    {!route.resourceId && !catalog.isPending && catalog.data?.items.length === 0 ? <p>No graders yet. Create and check one before publication.</p> : null}
    {!route.resourceId ? <AuthoringDraftList client={client} targetKind="reward" onResume={setResuming} /> : null}
    {editing || resuming ? <WorkspacePanel label="Grader editor" action="grader"><header><h2>{entry ? "Publish update" : "Create grader"}</h2><button onClick={() => { if (closeRef.current) closeRef.current.requestClose(); else { setEditing(null); setResuming(null); } }}>Close</button></header>{resuming ? <AuthoringDraftEditor closeRef={closeRef} client={client} draft={resuming} onClose={() => setResuming(null)} onPublished={id => { setResuming(null); refresh(); navigate({ ...route, resourceId: id, detailTab: "overview" }); }} /> : editing === "new" && !starter ? <GraderStarterChoices onSelect={setStarter} /> : <RewardEditor initialFields={starter ?? undefined} closeRef={closeRef} allowedKinds={["custom_verifier", "state", "content", "schema", "artifact", "runtime_event", "model_judge"]} client={client} reward={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reward => { setEditing(null); refresh(); navigate({ ...route, resourceId: reward.id, detailTab: "overview" }); }} />}</WorkspacePanel> : null}
  </>;
}
