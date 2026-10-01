import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ConnectedCaptureReceiptSchema, ConnectedCollectionSchema, ConnectedCaseRefSchema, ConnectedSourceSummarySchema } from "openpond-sdk/connected-evidence";
import { DatasetWorkspaceReceiptSchema } from "openpond-sdk/dataset-workspaces";
import type { WorkspaceApi } from "../workspace-api";
import { WorkspacePanel } from "../WorkspacePanel";
import { connectedCommand } from "./client";
import { ConnectedCaseInspector } from "./ConnectedCaseInspector";
import { AgentImportPanel } from "./AgentImportPanel";
type Ref = z.infer<typeof ConnectedCaseRefSchema>;
const pageSchema = z.object({ teamId: z.string(), items: z.array(ConnectedSourceSummarySchema), nextCursor: z.string().nullable() }).strict();

export function ConnectedSources({ api, ownerUserId, projects, onClose, onDataset, initialSelection }: {
  initialSelection?: Ref;
  api: WorkspaceApi; ownerUserId: string; projects: { id: string; name: string }[]; onClose(): void; onDataset(id: string, projectId: string): void;
}) {
  const [importing, setImporting] = useState(false), [projection, setProjection] = useState<"turn" | "conversation">(initialSelection ? "conversation" : "turn"), [selected, setSelected] = useState<Map<string, Ref>>(() => initialSelection ? new Map([[JSON.stringify(initialSelection), initialSelection]]) : new Map());
  const [inspected, setInspected] = useState<Ref | null>(initialSelection ?? null), [destination, setDestination] = useState(api.projectId ?? projects[0]?.id ?? ""), [name, setName] = useState("Selected recorded activity");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [recovery, setRecovery] = useState(""), [pending, setPending] = useState<string | null>(null);
  const sources = useInfiniteQuery({ queryKey: ["connected-sources", api.key], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => connectedCommand(api, "list", { limit: 20, ...(api.projectId ? { projectId: api.projectId } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, pageSchema), getNextPageParam: page => page.nextCursor ?? undefined });
  const collection = useQuery({ queryKey: ["connected-collection", api.key], queryFn: () => connectedCommand(api, "read_collection", {}, ConnectedCollectionSchema) });
  async function collect() {
    setBusy(true); setError(null); let cursor: string | undefined, count = 0;
    try { const cursors = new Set<string>(); do { const receipt = await connectedCommand(api, "capture", { operationId: crypto.randomUUID(), limit: 20, ...(cursor ? { cursor } : {}) }, ConnectedCaptureReceiptSchema); cursor = receipt.nextCursor ?? undefined; count += receipt.outcomes.filter(outcome => outcome.state === "captured").length;
        if (cursor && cursors.has(cursor)) throw new Error("Capture pagination repeated its cursor."); if (cursor) cursors.add(cursor); if (cursors.size > 500) throw new Error("Capture reached its bounded recovery window. Continue recovery after this batch."); } while (cursor);
      setRecovery(`${count} conversations recovered.`); await sources.refetch(); await collection.refetch();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Capture interrupted."); } finally { setBusy(false); }
  }
  async function changeCollection() { setBusy(true); setError(null); try { await connectedCommand(api, "collection", { paused: collection.data?.status !== "paused" }, ConnectedCollectionSchema); await collection.refetch(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Collection unavailable."); } finally { setBusy(false); } }
  async function freeze() {
    setBusy(true); setError(null);
    try { const request = { projectId: destination, name, cases: [...selected.values()] }, operation = await api.operation("connectedSelection", request); if (pending && operation.id !== pending) throw new Error("Selected Dataset recovery operation changed."); setPending(operation.id);
      const receipt = await connectedCommand(api, "create_selection", { ...request, operationId: operation.id }, DatasetWorkspaceReceiptSchema); await operation.acknowledge(); onDataset(receipt.datasetId, destination);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Selection interrupted. Retry the same selection."); } finally { setBusy(false); }
  }
  return <WorkspacePanel action="connected-sources" label="Recorded activity and imports" onRequestClose={() => { if (!busy) onClose(); }}><h2>Recorded activity and imports</h2>
    <p>Native Chat and committed Work activity stays private in your personal Project. Imported evidence never starts evaluation or training.</p>
    <div className="evaluation-workspace-scope"><button className="training-button secondary" disabled={busy} onClick={() => void collect()}>Recover committed activity</button><button className="training-button secondary" onClick={() => setImporting(true)}>Import agent runs</button>
      {collection.data ? <><span>Collection {collection.data.status}</span>{collection.data.status !== "archived" ? <button disabled={busy} onClick={() => void changeCollection()}>{collection.data.status === "paused" ? "Resume" : "Pause"}</button> : null}</> : null}</div>
    <label>Evaluation unit<select value={projection} onChange={event => setProjection(event.target.value as typeof projection)}><option value="turn">Turns</option><option value="conversation">Conversations</option></select></label>
    {error || sources.error || collection.error ? <p role="alert">{error ?? sources.error?.message ?? collection.error?.message}</p> : null}{recovery ? <p role="status">{recovery}</p> : null}
    <ul>{sources.data?.pages.flatMap(page => page.items).map(source => <li key={source.sourceId}><h3>{source.title}</h3><p>{source.source.replaceAll("_", " ")}</p><ul>{source.boundaries.filter(boundary => boundary.projection === projection).map(boundary => {
      const ref = { id: source.sourceId, snapshotHash: source.snapshotHash, boundaryId: boundary.id, boundaryRevisionHash: boundary.revisionHash }, key = JSON.stringify(ref);
      return <li key={key}><label><input type="checkbox" disabled={busy || Boolean(pending)} checked={selected.has(key)} onChange={() => setSelected(previous => { const next = new Map(previous); if (next.has(key)) next.delete(key); else next.set(key, ref); return next; })} />{boundary.id}: {boundary.coverage.answer ? "answer retained" : "answer unavailable"}; process {boundary.coverage.process}; {boundary.terminal}</label><button onClick={() => setInspected(ref)}>Inspect input and trace</button></li>;
    })}</ul></li>)}</ul>
    {sources.isPending ? <p role="status">Loading retained sources…</p> : null}{sources.hasNextPage ? <button disabled={sources.isFetchingNextPage} onClick={() => void sources.fetchNextPage()}>More sources</button> : null}
    <section><h3>Freeze exact selection</h3><p>{selected.size} pinned cases. Later captures and source pages cannot add cases to this selection. Select graders, validate fixtures, and publish the resulting Dataset before evaluation.</p>
      <label>Dataset name<input disabled={busy || Boolean(pending)} value={name} onChange={event => setName(event.target.value)} /></label><label>Personal Project<select disabled={busy || Boolean(pending)} value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose Project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <button className="training-button" disabled={busy || !destination || !name.trim() || !selected.size} onClick={() => void freeze()}>{pending ? "Retry same selected Dataset" : "Create selected Dataset"}</button></section>
    {inspected ? <ConnectedCaseInspector api={api} evidenceRef={inspected} onClose={() => setInspected(null)} /> : null}
    {importing ? <AgentImportPanel api={api} ownerUserId={ownerUserId} projectId={api.projectId ?? undefined} projects={projects} onClose={() => setImporting(false)} onImported={receipt => { const dataset = receipt.outcomes.flatMap(outcome => outcome.datasets)[0]; if (dataset && receipt.projectId) onDataset(dataset.datasetId, receipt.projectId); }} /> : null}
  </WorkspacePanel>;
}
