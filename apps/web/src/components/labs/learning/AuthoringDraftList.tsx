import { useState } from "react";
import { learningRef, type AuthoringDraft, type AuthoringTargetKind, type OpenPondLearningClient } from "openpond-sdk/learning";
import { LearningError, LearningPager } from "./LearningFields";
import { useLearningMutation, useLearningResources } from "./useLearningResources";

export function AuthoringDraftList({ client, targetKind, onResume }: { client: OpenPondLearningClient | null; targetKind: AuthoringTargetKind; onResume: (draft: AuthoringDraft) => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const resources = useLearningResources(client, "draft", { parentId: targetKind, status: "draft", limit: 20, ...(after ? { afterId: after } : {}) });
  const mutation = useLearningMutation(client);
  if (!resources.loading && !resources.error && !resources.page?.items.length && !after) return null;
  return <section><h2>Saved drafts</h2><LearningError error={resources.error ?? mutation.error} />
    {resources.loading ? <p role="status">Loading drafts…</p> : <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Draft</th><th>Saved</th><th>Actions</th></tr></thead><tbody>{resources.page?.items.map(draft => <tr key={draft.id}><td>{draft.fields.name || "Untitled draft"}</td><td>{new Date(draft.updatedAt).toLocaleString()}</td><td><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => onResume(draft)}>Resume draft</button><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={async () => { if (await mutation.command({ action: "archive_draft", operationId: `archive:${draft.contentHash}`, draft: learningRef(draft) })) resources.refresh(); }}>Archive draft</button></td></tr>)}</tbody></table></div>}
    <LearningPager after={after} next={resources.page?.nextCursor} onPage={setAfter} />
  </section>;
}
