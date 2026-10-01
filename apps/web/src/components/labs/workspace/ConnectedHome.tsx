import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ConnectedHomeSummarySchema } from "openpond-sdk/connected-evidence";
import type { ClientConnection } from "../../../api";
import { createWorkspaceApi, type Inventory } from "./workspace-api";

export function ConnectedHome({ connection, teamId, actorId, projectId, onProjectChange, onOpenSources }: {
  connection: ClientConnection | null; teamId: string | null; actorId: string | null; projectId?: string | null;
  onProjectChange(projectId: string | null): void; onOpenSources(projectId: string | null): void;
}) {
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }));
  const api = connection && teamId && actorId ? createWorkspaceApi(connection, { teamId, actorId, projectId: projectId ?? null, accountKey: actorId }) : null;
  const projects = useInfiniteQuery({ queryKey: ["connected-home-projects", teamId, actorId], enabled: Boolean(api), initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => api!.request<Inventory["projects"]>("projects", pageParam ? { cursor: pageParam } : {}, signal), getNextPageParam: page => page.nextCursor ?? undefined });
  const input = { from: `${range.from}T00:00:00.000Z`, to: new Date(new Date(`${range.to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString(), ...(projectId ? { projectId } : {}) };
  const summary = useQuery({ queryKey: ["connected-home", api?.key, input], enabled: Boolean(api), queryFn: async ({ signal }) => ConnectedHomeSummarySchema.parse(await api!.request("connectedSummary", input, signal)) });
  const data = summary.data, totals = data?.usage.total, fmt = (number: number) => number.toLocaleString();
  if (!api) return <p role="status">Sign in and select a workspace to open Home.</p>;
  return <main className="evaluation-workspace"><header className="evaluation-workspace-header"><h1>Home</h1><button className="training-button secondary" onClick={() => onOpenSources(projectId ?? null)}>Recorded activity and imports</button></header>
    <div className="evaluation-workspace-scope"><label>Project<select value={projectId ?? ""} onChange={event => onProjectChange(event.target.value || null)}><option value="">All Projects</option>{projects.data?.pages.flatMap(page => page.projects).filter(project => !project.archived).map(project => <option key={project.id} value={project.id}>{project.content.name}</option>)}</select></label>
      {projects.hasNextPage ? <button disabled={projects.isFetchingNextPage} onClick={() => void projects.fetchNextPage()}>More Projects</button> : null}
      <label>From<input type="date" value={range.from} max={range.to} onChange={event => event.target.value && setRange(previous => ({ ...previous, from: event.target.value }))} /></label>
      <label>To<input type="date" value={range.to} min={range.from} onChange={event => event.target.value && setRange(previous => ({ ...previous, to: event.target.value }))} /></label></div>
    {summary.error || projects.error ? <p role="alert">{(summary.error ?? projects.error)!.message}</p> : null}
    {summary.isPending ? <p role="status">Loading activity and invocation receipts…</p> : null}
    {data && totals ? <><dl className="evaluation-workspace-meta">{[["Conversations", data.activity.conversations], ["Chat turns", data.activity.chatTurns], ["Work turns", data.activity.workTurns], ["Model invocations", totals.invocations]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{fmt(Number(value))}</dd></div>)}</dl>
      <p>{fmt(totals.inputTokens)} known input tokens; {fmt(totals.cachedInputTokens)} known cached input tokens; {fmt(totals.outputTokens)} known output tokens. {fmt(totals.missingTotal)} invocations have no total-token receipt. {fmt(totals.unattributed)} lack a Project attribution. Dates use UTC.</p>
      {data.accounting.contextSnapshots ? <p>{fmt(data.accounting.contextSnapshots)} context occupancy snapshots are retained separately and excluded from invocation and token totals.</p> : null}
      {data.usage.days.length ? <figure><figcaption>Model invocations by day</figcaption><svg role="img" aria-label="Daily model invocation counts; exact values appear in the table below" viewBox={`0 0 ${Math.max(data.usage.days.length * 16, 160)} 90`} style={{ height: 110, width: "100%" }} preserveAspectRatio="none">
        {data.usage.days.map((day, index) => { const height = 80 * day.invocations / Math.max(1, ...data.usage.days.map(row => row.invocations)); return <rect key={day.key} x={index * 16} y={85 - height} width={12} height={height} fill="currentColor"><title>{day.key}: {fmt(day.invocations)} invocations</title></rect>; })}</svg></figure> : null}
      <table className="training-data-table"><caption>Invocation usage by day</caption><thead><tr><th>Date</th><th>Invocations</th><th>Input</th><th>Cached input</th><th>Output</th><th>Missing total</th></tr></thead><tbody>{data.usage.days.map(day => <tr key={day.key}><td>{day.key}</td><td>{fmt(day.invocations)}</td><td>{fmt(day.inputTokens)}</td><td>{fmt(day.cachedInputTokens)}</td><td>{fmt(day.outputTokens)}</td><td>{fmt(day.missingTotal)}</td></tr>)}</tbody></table>
      <details><summary>Modes and models</summary>{[data.usage.modes, data.usage.models].map((group, index) => <table className="training-data-table" key={index}><caption>{index ? "Models" : "Modes"}</caption><thead><tr><th>Name</th><th>Invocations</th><th>Known total tokens</th></tr></thead><tbody>{group.map(row => <tr key={row.key}><td>{row.key.replaceAll("_", " ")}</td><td>{fmt(row.invocations)}</td><td>{fmt(row.totalTokens)}</td></tr>)}</tbody></table>)}</details></> : null}
  </main>;
}
