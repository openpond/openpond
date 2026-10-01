import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ConnectedCaseReadbackSchema, ConnectedUnmappedEventsSchema, type ConnectedCaseRefSchema } from "openpond-sdk/connected-evidence";
import type { z } from "zod";
import { WorkspacePanel } from "../WorkspacePanel";
import type { WorkspaceApi } from "../workspace-api";
import { connectedCommand } from "./client";
import { Button } from "./controls";

export function ConnectedCaseInspector({ api, evidenceRef, onClose }: { api: WorkspaceApi; evidenceRef: z.infer<typeof ConnectedCaseRefSchema>; onClose(): void }) {
  const teamId = api.teamId;
  const query = useQuery({ queryKey: ["connected-case", api.key, teamId, evidenceRef], queryFn: () => connectedCommand(api, "read", evidenceRef, ConnectedCaseReadbackSchema) });
  const evidence = query.isPending ? undefined : query.data?.evidence;
  const unmapped = useInfiniteQuery({ queryKey: ["connected-unmapped", api.key, teamId, evidenceRef.id, evidenceRef.snapshotHash],
    enabled: !query.isPending && Boolean(query.data?.unmappedEvidence.count), initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const page = await connectedCommand(api, "read_unmapped", { id: evidenceRef.id, snapshotHash: evidenceRef.snapshotHash, offset: pageParam, limit: 20 }, ConnectedUnmappedEventsSchema);
      if (page.sourceId !== evidenceRef.id || page.snapshotHash !== evidenceRef.snapshotHash || page.contentHash !== query.data?.unmappedEvidence.contentHash
        || page.count !== query.data.unmappedEvidence.count || page.offset !== pageParam || page.events.some((event, index) => event.sequence !== pageParam + index))
        throw new Error("Source process evidence differs from its pinned snapshot.");
      return page;
    }, getNextPageParam: page => page.nextOffset ?? undefined });
  return <WorkspacePanel action="connected-case" label="Recorded input and evidence" onRequestClose={onClose}><h2>Recorded input and evidence</h2>
    {query.isPending ? <p role="status">Loading retained evidence…</p> : null}
    {query.error ? <p role="alert">{query.error.message}</p> : null}
    {evidence ? <div className="space-y-5 text-sm">
      <p>{query.data!.origin.replaceAll("_", " ")} {evidence.boundary.projection}. {evidence.boundary.terminal}.</p>
      <p className="text-muted-foreground">Context: {evidence.boundary.coverage.context}. Process: {evidence.boundary.coverage.process}. Artifacts: {evidence.boundary.coverage.artifacts}.</p>
      {evidence.boundary.coverage.gaps.length ? <ul className="list-disc pl-5 text-muted-foreground">{evidence.boundary.coverage.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : null}
      <section><h3 className="font-medium">Frozen input</h3><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(evidence.input, null, 2)}</pre></section>
      <section><h3 className="font-medium">Recorded answer</h3><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(evidence.answer, null, 2)}</pre></section>
      <section><h3 className="font-medium">Observed trace</h3><ol className="divide-y divide-border">{evidence.observed.map(event => <li key={event.id} className="py-3">
        <p>{event.kind.replaceAll("_", " ")} {event.role ?? ""} {event.occurredAt ?? "Time unavailable"}</p>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(event.content, null, 2)}</pre>
      </li>)}</ol></section>
      {query.data!.unmappedEvidence.count ? <section><h3 className="font-medium">Unassigned source process events</h3>
        <p className="text-muted-foreground">These {query.data!.unmappedEvidence.count} events belong to the source export. Their case mapping is unavailable, so they are excluded from the frozen input and observed trace above.</p>
        {unmapped.error ? <p role="alert">{unmapped.error.message}</p> : null}
        <ol className="divide-y divide-border">{unmapped.data?.pages.flatMap(page => page.events).map(event => <li key={event.id} className="py-3"><p>{event.kind.replaceAll("_", " ")} {event.occurredAt ?? "Time unavailable"}</p>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(event.content, null, 2)}</pre></li>)}</ol>
        <Button variant="outline" disabled={unmapped.isFetching || !unmapped.hasNextPage} onClick={() => void unmapped.fetchNextPage()}>{unmapped.isFetching ? "Loading…" : "Load more process events"}</Button>
      </section> : null}
      <details><summary>Source identity</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(query.data!.ref, null, 2)}</pre></details>
    </div> : null}
  </WorkspacePanel>;
}
