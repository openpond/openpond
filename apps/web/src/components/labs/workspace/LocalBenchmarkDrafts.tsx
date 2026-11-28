import { ChatExperimentContextSchema, type Session } from "@openpond/contracts";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";
import { EvaluationTime } from "./EvaluationPresentation";

export function LocalBenchmarkDrafts({ sessions, search, onOpen }: {
  sessions: readonly Session[];
  search: string;
  onOpen(id: string): void;
}) {
  const query = search.trim().toLowerCase();
  const drafts = sessions.flatMap(session => {
    if (session.archived) return [];
    const resource = SessionResourceDraftSchema.safeParse(session.metadata?.resourceDraft);
    if (!resource.success || resource.data.kind !== "benchmark") return [];
    const context = ChatExperimentContextSchema.safeParse(session.metadata?.chatExperimentContext);
    if (!context.success) return [];
    const scope = context.data.scopes.find(candidate => candidate.draft?.id === resource.data.id);
    if (!scope || !scope.name.toLowerCase().includes(query)) return [];
    return [{ sessionId: session.id, scope }];
  }).sort((left, right) => right.scope.updatedAt.localeCompare(left.scope.updatedAt));

  return <section className="labs-operational-section" aria-label="Local Benchmark drafts">
    <div className="training-section-heading"><h2>Local drafts</h2></div>
    <div className="training-table-wrap"><table className="training-data-table" aria-label="Local Benchmark drafts">
      <thead><tr><th>Benchmark</th><th>Revision</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>
        {drafts.map(({ sessionId, scope }) => <tr key={sessionId}>
          <td>{scope.name}</td><td>{scope.draftRevision ?? 1}</td><td><EvaluationTime value={scope.updatedAt} /></td>
          <td><button className="training-text-button" type="button" onClick={() => onOpen(sessionId)}>Open setup</button></td>
        </tr>)}
        {!drafts.length ? <tr><td colSpan={4}>No matching local Benchmark drafts.</td></tr> : null}
      </tbody>
    </table></div>
  </section>;
}
