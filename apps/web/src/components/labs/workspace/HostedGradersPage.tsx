import { useQuery } from "@tanstack/react-query";
import type { GraderCatalogPageSchema, GraderVersionsPageSchema, GraderUsagePageSchema } from "openpond-sdk/learning";
import type { z } from "zod";
import { WorkspacePanel } from "./WorkspacePanel";
import { useMemo, useState } from "react";
import { OpenPondLearningClient, type AuthoringDraft, type RewardRelease, learningRef } from "openpond-sdk/learning";
import { scopeLearningClient } from "../../../lib/query-scope";
import { useLearningResource, useLearningResources } from "../learning/useLearningResources";
import { RewardEditor } from "../learning/RewardEditor";
import { RewardCheckHistory } from "../learning/RewardCheckHistory";
import { AuthoringDraftList } from "../learning/AuthoringDraftList";
import { AuthoringDraftEditor } from "../learning/AuthoringDraftEditor";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";
export function HostedGradersPage({ api, route, navigate }: { api: WorkspaceApi; route: ModelsRoute; navigate: (route: ModelsRoute) => void }) {
  const client = useMemo(() => scopeLearningClient(new OpenPondLearningClient({ baseUrl: "https://desktop.openpond.invalid", apiKey: "desktop-server-boundary", scope: api.teamId, fetch: async (url, init) => {
    const endpoint = new URL(String(url)).pathname.split("/").at(-1);
    if (endpoint !== "read" && endpoint !== "commands") throw new Error("Unsupported grader action.");
    const result = await api.request("learningRelay", { endpoint, request: JSON.parse(String(init?.body)) }, init?.signal ?? undefined);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } }), ["learning", "hosted-evaluation-workspace", api.key]), [api]);
  const resources = useLearningResources(client, "reward", { limit: 100 });
  const selected = useLearningResource(client, "reward", route.resourceId);
  const [editing, setEditing] = useState<RewardRelease | "new" | null>(null);
  const [resuming, setResuming] = useState<AuthoringDraft | null>(null);
  const [revision, setRevision] = useState<number | undefined>();
  const [section, setSection] = useState<"projects" | "datasets" | "runs">("datasets");
  const [sort, setSort] = useState("name");
  const catalog = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderCatalog", route.query, sort, route.after], queryFn: ({ signal }) => api.request<z.infer<typeof GraderCatalogPageSchema>>("graderCatalog", { search: route.query, sort, ...(route.after ? { after: route.after } : {}) }, signal) });
  const versions = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderVersions", route.resourceId], enabled: Boolean(route.resourceId), queryFn: ({ signal }) => api.request<z.infer<typeof GraderVersionsPageSchema>>("graderVersions", { id: route.resourceId }, signal) });
  const usage = useQuery({ queryKey: ["evaluation-workspace", api.key, "graderUsage", route.resourceId, section], enabled: Boolean(route.resourceId && route.detailTab === "usage"), queryFn: ({ signal }) => api.request<z.infer<typeof GraderUsagePageSchema>>("graderUsage", { id: route.resourceId, query: { section } }, signal) });
  const entry = versions.data?.items.find(item => item.revision === revision) ?? selected.resource;
  const tab = route.detailTab ?? "overview";
  return <>
    <header className="evaluation-workspace-header"><h1>{entry?.name ?? "Graders"}</h1><button className="training-button" onClick={() => setEditing(entry ?? "new")}>{entry ? "Publish update" : "+ Grader"}</button></header>
    {resources.error || selected.error ? <p role="alert">{resources.error ?? selected.error}</p> : null}
    {resources.loading ? <p role="status">Loading graders…</p> : null}
    {entry ? <><nav className="evaluation-workspace-tabs" aria-label="Grader tabs">{["overview", "checks", "usage", "versions"].map(value => <button key={value} aria-selected={tab === value} onClick={() => navigate({ ...route, detailTab: value })}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
      {tab === "checks" ? <RewardCheckHistory client={client} targetId={entry.id} draft={null} unchanged={false} busy={false} published={learningRef(entry)} readOnly /> : tab === "versions" ? <ul>{versions.data?.items.map(item => <li key={item.revision}><button className="training-text-button" onClick={() => { setRevision(item.revision); navigate({ ...route, detailTab: "overview" }); }}>Revision {item.revision} · {item.contentHash}</button></li>)}</ul> : tab === "usage" ? <><label>Usage in <select value={section} onChange={event => setSection(event.target.value as typeof section)}>{["projects", "datasets", "runs"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{usage.error ? <p role="alert">{usage.error.message}</p> : null}<ul>{usage.data?.items.map(item => <li key={item.id}>{item.name} {"graderRevisions" in item ? `· Revisions ${item.graderRevisions.join(", ")}` : "status" in item ? `· ${item.status}` : ""}</li>)}</ul></> : <><dl className="evaluation-workspace-meta"><dt>Release</dt><dd>{entry.id} · Revision {entry.revision}</dd><dt>Feedback</dt><dd>{entry.feedbackKey}</dd><dt>Version</dt><dd>{entry.revision}</dd><dt>Content hash</dt><dd>{entry.contentHash}</dd></dl><pre>{JSON.stringify(entry.implementation, null, 2)}</pre></>}
    </> : <><label>Search graders <input value={route.query} onChange={event => navigate({ ...route, query: event.target.value, after: null })} /></label><label>Sort <select value={sort} onChange={event => setSort(event.target.value)}>{["name", "type", "version", "projects", "datasets", "runs"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>{catalog.error ? <p role="alert">{catalog.error.message}</p> : null}<table className="training-data-table evaluation-workspace-table"><thead><tr><th>Grader</th><th>Feedback key</th><th>Version</th><th>Revision</th></tr></thead><tbody>{catalog.data?.items.map(({ reward: item }) => <tr key={item.id} tabIndex={0} onClick={() => navigate({ ...route, resourceId: item.id })} onKeyDown={event => { if (event.key === "Enter") navigate({ ...route, resourceId: item.id }); }}><td>{item.name}</td><td>{item.feedbackKey}</td><td>{item.revision}</td><td>{item.revision}</td></tr>)}</tbody></table>{catalog.data?.nextCursor ? <button onClick={() => navigate({ ...route, after: catalog.data!.nextCursor })}>More graders</button> : null}</>}
    {!resources.loading && resources.page?.items.length === 0 ? <p>No graders yet. Create and check one before publication.</p> : null}
    {!route.resourceId ? <AuthoringDraftList client={client} targetKind="reward" onResume={setResuming} /> : null}
    {editing || resuming ? <WorkspacePanel label="Grader editor"><header><h2>{entry ? "Publish update" : "Create grader"}</h2><button onClick={() => { setEditing(null); setResuming(null); }}>Close</button></header>{resuming ? <AuthoringDraftEditor client={client} draft={resuming} onClose={() => setResuming(null)} onPublished={() => { setResuming(null); resources.refresh(); }} /> : <RewardEditor allowedKinds={["custom_verifier", "state", "content", "schema", "artifact", "runtime_event", "model_judge"]} client={client} reward={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); resources.refresh(); selected.refresh(); }} />}</WorkspacePanel> : null}
  </>;
}
