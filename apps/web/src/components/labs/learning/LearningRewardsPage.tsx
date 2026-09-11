import { useState } from "react";
import { type AuthoringDraft, type RewardRelease } from "openpond-sdk/learning";

import { ModelsPageSearch } from "../ModelsPageSearch";
import type { OpenPondLearningClient as LearningClient } from "openpond-sdk/learning";
import { AuthoringDraftList } from "./AuthoringDraftList";
import { AuthoringDraftEditor } from "./AuthoringDraftEditor";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningError, LearningPager } from "./LearningFields";
import { RewardImplementationDetails, graderImplementationLabel } from "./RewardImplementationDetails";
import { useLearningCatalog, useLearningResource } from "./useLearningResources";
import { RewardEditor } from "./RewardEditor";
import { LearningEditorDialog } from "./LearningEditorDialog";
import { RewardCheckHistory } from "./RewardCheckHistory";

export function LearningRewardsPage({ client, selectedId, after, onSelect, onPage }: { client: LearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (after: string | null) => void }) {
  const resources = useLearningCatalog(client, "reward");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [resuming, setResuming] = useState<AuthoringDraft | null>(null);
  const [editing, setEditing] = useState<RewardRelease | "new" | null>(null);
  const selected = useLearningResource(client, "reward", selectedId);
  const entry = selected.resource ?? resources.items.find(item => item.id === selectedId) ?? null;
  const query = search.toLowerCase();
  const matches = resources.items.filter(reward => (!kind || reward.implementation.kind === kind) && (!query || [reward.name, reward.description, graderImplementationLabel(reward)].some(value => value.toLowerCase().includes(query))));
  const start = after ? Math.max(0, matches.findIndex(item => item.id === after) + 1) : 0;
  const rows = matches.slice(start, start + 30);
  const next = start + rows.length < matches.length ? rows.at(-1)?.id : null;
  const kinds = [...new Map(resources.items.map(reward => [reward.implementation.kind, graderImplementationLabel(reward)])).entries()];
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={entry?.name ?? "Graders"} actions={entry ? <><button type="button" className="training-button secondary" onClick={() => onSelect(null)}>All graders</button><button type="button" className="training-button" onClick={() => setEditing(entry)}>Edit grader</button></> : <><ModelsPageSearch label="Search graders" value={search} onSearch={value => { setSearch(value); onPage(null); }} /><button type="button" className="training-button" onClick={() => setEditing("new")}>New grader</button></>} />
    <LearningError error={resources.error ?? selected.error} />
    {entry ? <>
      <p className="models-catalog-description">{entry.description}</p>
      <RewardImplementationDetails client={client} reward={entry} />
      <details><summary>Check history</summary><RewardCheckHistory client={client} targetId={entry.id} draft={null} published={entry} unchanged={false} busy={false} /></details>
    </> : selectedId ? <p role="status">{selected.error ? "This grader is unavailable." : "Loading grader…"}</p> : <>
      <div className="labs-workproduct-toolbar"><p className="models-catalog-description">Published graders in this workspace{resources.loading ? "" : ` · ${matches.length}`}. Models and task formats can reuse them.</p>
        <select aria-label="Grader type" value={kind} onChange={event => { setKind(event.target.value); onPage(null); }}><option value="">All types</option>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Grader</th><th>Type</th><th>Version</th><th>Score range</th></tr></thead><tbody>{rows.map(reward => <tr key={reward.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(reward.id)}><strong>{reward.name}</strong>{reward.description ? <small>{reward.description}</small> : null}</button></td><td>{graderImplementationLabel(reward)}</td><td>{reward.revision}</td><td>{reward.rawScore.minimum}–{reward.rawScore.maximum}</td></tr>)}</tbody></table></div>
      {resources.loading ? <p role="status">Loading graders…</p> : !rows.length ? <p>{search || kind ? "No graders match this view." : "No graders have been published in this workspace."}</p> : null}
      <LearningPager after={after} next={next} onPage={onPage} />
      <details><summary>Saved drafts</summary><AuthoringDraftList client={client} targetKind="reward" onResume={setResuming} /></details>
    </>}
    {resuming ? <LearningEditorDialog title="Resume grader" onClose={() => setResuming(null)}><AuthoringDraftEditor key={resuming.id} client={client} draft={resuming} onClose={() => setResuming(null)} onPublished={id => { setResuming(null); selected.refresh(); resources.refresh(); onSelect(id); }} /></LearningEditorDialog> : null}
    {editing ? <LearningEditorDialog title={editing === "new" ? "New grader" : "Edit grader"} onClose={() => setEditing(null)}><RewardEditor key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} client={client} reward={editing === "new" ? null : editing} onSaved={reward => { setEditing(null); selected.refresh(); resources.refresh(); onSelect(reward.id); }} onClose={() => setEditing(null)} /></LearningEditorDialog> : null}
  </div>;
}
