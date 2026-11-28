import type { Session } from "@openpond/contracts";
import { useState } from "react";
import type { hostedModelScope } from "../../../lib/hosted-model-scope";
import { sessionBenchmarkDraft } from "../../../lib/session-benchmark";
import { EvaluationTime } from "./EvaluationPresentation";

export function LocalBenchmarkDrafts({ sessions, search, workspace, onOpen, onOpenHosted, onSync }: {
  sessions: readonly Session[];
  search: string;
  workspace: ReturnType<typeof hostedModelScope>;
  onOpen(id: string): void;
  onOpenHosted(id: string): void;
  onSync?: (sessionId: string, scopeId: string, revision: number) => Promise<void>;
}) {
  const [syncing, setSyncing] = useState<string | null>(null);
  const query = search.trim().toLowerCase();
  const drafts = sessions.flatMap(session => {
    const scope = sessionBenchmarkDraft(session, workspace);
    if (!scope || !scope.name.toLowerCase().includes(query)) return [];
    return [{ sessionId: session.id, scope }];
  }).sort((left, right) => right.scope.updatedAt.localeCompare(left.scope.updatedAt));

  return <section className="labs-operational-section" aria-label="Local Benchmark drafts">
    <div className="training-section-heading"><h2>Local drafts</h2></div>
    <div className="training-table-wrap"><table className="training-data-table" aria-label="Local Benchmark drafts">
      <thead><tr><th>Benchmark</th><th>Revision</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>
        {drafts.map(({ sessionId, scope }) => {
          const revision = scope.draftRevision ?? 1;
          const link = scope.syncedDraft;
          const sync = link && workspace && link.actorId === workspace.actorId &&
            link.teamId === workspace.teamId && link.apiOrigin === workspace.apiOrigin ? link : null;
          const synced = sync && sync.sourceRevision === revision &&
            sync.baselineVersionHash === scope.managedBenchmarkVersions?.baseline?.versionHash;
          return <tr key={sessionId}>
            <td>{scope.name}</td><td>{revision}</td><td><EvaluationTime value={scope.updatedAt} /></td>
            <td><div className="model-build-actions">
              <button className="training-text-button" type="button" onClick={() => onOpen(sessionId)}>Open setup</button>
              {onSync && !synced ? <button className="training-button secondary" type="button" disabled={syncing !== null}
                onClick={async () => {
                  setSyncing(sessionId);
                  try { await onSync(sessionId, scope.id, revision); } finally { setSyncing(null); }
                }}>{syncing === sessionId ? "Syncing…" : "Sync privately"}</button> : null}
              {synced ? <span>Synced</span> : null}
              {sync ? <button className="training-text-button" type="button" onClick={() => onOpenHosted(sync.id)}>Open hosted draft</button> : null}
            </div></td>
          </tr>;
        })}
        {!drafts.length ? <tr><td colSpan={4}>No matching local Benchmark drafts.</td></tr> : null}
      </tbody>
    </table></div>
  </section>;
}
