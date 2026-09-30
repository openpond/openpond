import { useState } from "react";
import type { Inventory, WorkspaceApi } from "./workspace-api";

export function ProjectScopePicker({ api, page, selectedId, onChange }: { api: WorkspaceApi; page: Inventory["projects"] | undefined; selectedId: string | null; onChange: (id: string | null) => void }) {
  const [additional, setAdditional] = useState<Inventory["projects"][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = [...new Map([...(page?.projects ?? []), ...additional.flatMap(value => value.projects)].map(project => [project.id, project])).values()].filter(project => !project.archived);
  const cursor = additional.length ? additional.at(-1)!.nextCursor : page?.nextCursor;
  async function loadMore() {
    if (!cursor || busy) return; setBusy(true); setError(null);
    try { const next = await api.request<Inventory["projects"]>("projects", { cursor }); setAdditional(pages => [...pages, next]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <><label htmlFor="evaluation-project">Project</label><select id="evaluation-project" value={selectedId ?? ""} onChange={event => onChange(event.target.value || null)}><option value="">All projects</option>{selectedId && !projects.some(project => project.id === selectedId) ? <option value={selectedId}>Unavailable Project</option> : null}{projects.map(project => <option key={project.id} value={project.id}>{project.content.name}</option>)}</select>{cursor ? <button className="training-text-button" disabled={busy} onClick={() => void loadMore()}>{busy ? "Loading Projects…" : "More Projects"}</button> : null}{error ? <span role="alert">{error}</span> : null}</>;
}
