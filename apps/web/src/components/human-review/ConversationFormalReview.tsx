import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ConnectedSourceSummarySchema, ConnectedCaseReadbackSchema, type ConnectedCaseRefSchema } from "openpond-sdk/connected-evidence";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { modelsLocation, navigateModelsRoute } from "../labs/lab-primary-tab-state";

const Page = z.object({ teamId: z.string(), items: z.array(ConnectedSourceSummarySchema).max(50), nextCursor: z.string().nullable() }).strict();
/** A contextual entry reads already captured, sealed evidence. Opening it never
 * captures activity, publishes a Dataset, dispatches a model or enrolls training. */
export function ConversationFormalReview({ connection, teamId, actorId, sessionId, scopeKey, running, onOpen }: {
  connection: ClientConnection; teamId: string; actorId: string; sessionId: string; scopeKey: string; running: boolean; onOpen(): void;
}) {
  const query = useQuery({ queryKey: ["conversation-formal-review", scopeKey, teamId, actorId, sessionId], enabled: !running, staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const request = (operation: string, value: unknown) => apiFetch(connection, "/v1/training/evaluation-workspace", { method: "POST", signal,
        body: JSON.stringify({ teamId, projectId: null, operation, value }) });
      let cursor: string | undefined; const cursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const page = Page.parse(await request("connectedList", { limit: 50, ...(cursor ? { cursor } : {}) }));
        if (page.teamId !== teamId) throw new Error("Recorded evidence workspace changed.");
        for (const source of page.items.filter(item => item.sessionId === sessionId && ["native_chat", "native_work"].includes(item.source))) {
          const boundary = source.boundaries.find(item => item.projection === "conversation" && item.terminal !== "unknown" && item.coverage.answer && item.outputHash);
          if (!boundary || !source.projectId) continue;
          const ref: z.infer<typeof ConnectedCaseRefSchema> = { id: source.sourceId, snapshotHash: source.snapshotHash, boundaryId: boundary.id, boundaryRevisionHash: boundary.revisionHash };
          const evidence = ConnectedCaseReadbackSchema.parse(await request("connectedCase", ref));
          if (evidence.teamId !== teamId || evidence.sessionId !== sessionId || evidence.projectId !== source.projectId || contentHash(evidence.ref) !== contentHash(ref)
            || evidence.evidence.boundary.revisionHash !== ref.boundaryRevisionHash || evidence.evidence.boundary.outputHash !== boundary.outputHash)
            throw new Error("The retained conversation snapshot changed.");
          return { ref, projectId: source.projectId };
        }
        if (!page.nextCursor) return null;
        if (cursors.has(page.nextCursor)) throw new Error("Recorded source pagination repeated its cursor.");
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      return null; // A bounded search never invents an eligible source.
    } });
  if (!query.data || running) return null;
  return <button type="button" className="training-button secondary" onClick={async () => {
    // Navigation and destination read authorize the same immutable snapshot;
    // the query cache is only a discovery hint, never source authority.
    const next = modelsLocation("datasets", null, { area: "console", projectId: query.data!.projectId, reviewSource: query.data!.ref });
    if (await navigateModelsRoute(next)) onOpen();
  }}>Formally review retained conversation</button>;
}
