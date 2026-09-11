import type { OpenPondLearningClient } from "openpond-sdk/learning";
import { ModelsPageSearch } from "../ModelsPageSearch";
import { useState } from "react";
import type { AuthoringDraft } from "openpond-sdk/learning";
import { AuthoringDraftList } from "./AuthoringDraftList";
import { AuthoringDraftEditor } from "./AuthoringDraftEditor";
import type { RewardBinding } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { CombinedRewardEditor } from "./CombinedRewardEditor";
import { LearningEditorDialog } from "./LearningEditorDialog";
import { LearningActions, LearningError, LearningPager } from "./LearningFields";
import { RewardBindingSummary } from "./RewardBindingSummary";
import { useLearningResource, useLearningCatalog } from "./useLearningResources";

export function LearningCombinedRewardsPage({ client, selectedId, after, onSelect, onPage }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (after: string | null) => void }) {
  const resources = useLearningCatalog(client, "binding");
  const [search, setSearch] = useState("");
  const matches = resources.items.filter(binding => binding.name && (!search || `${binding.name} ${binding.description}`.toLowerCase().includes(search.toLowerCase())));
  const start = after ? Math.max(0, matches.findIndex(item => item.id === after) + 1) : 0;
  const rows = matches.slice(start, start + 30);
  const next = start + rows.length < matches.length ? rows.at(-1)?.id : null;
  const [resuming, setResuming] = useState<AuthoringDraft | null>(null);
  const [editing, setEditing] = useState<RewardBinding | "new" | null>(null);
  const selected = useLearningResource(client, "binding", selectedId);
  const entry = selected.resource ?? resources.items.find((item) => item.id === selectedId) ?? null;
  const resumeDialog = resuming ? <LearningEditorDialog title="Resume combination" onClose={() => setResuming(null)}><AuthoringDraftEditor key={resuming.id} client={client} draft={resuming} onClose={() => setResuming(null)} onPublished={(id) => { setResuming(null); selected.refresh(); resources.refresh(); onSelect(id); }} /></LearningEditorDialog> : null;
  const editDialog = editing ? <LearningEditorDialog title={editing === "new" ? "New combination" : "Edit combination"} onClose={() => setEditing(null)}><CombinedRewardEditor key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} client={client} binding={editing === "new" ? null : editing} onSaved={(binding) => { setEditing(null); selected.refresh(); resources.refresh(); onSelect(binding.id); }} onClose={() => setEditing(null)} /></LearningEditorDialog> : null;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={entry?.name ?? "Grader combinations"} description="Reusable combinations of exact grader versions, weights and gates. Select a combination while creating or editing a task format." actions={<>{!entry ? <ModelsPageSearch label="Search combinations" value={search} onSearch={value => { setSearch(value); onPage(null); }} /> : null}<button type="button" className="training-button" onClick={() => setEditing("new")}>New combination</button></>} />
    <LearningError error={resources.error ?? selected.error} />
    {entry ? <>
      <LearningActions><button className="training-button secondary" type="button" onClick={() => onSelect(null)}>All combinations</button><button className="training-button" type="button"  onClick={() => setEditing(entry)}>Edit as next release</button></LearningActions>
      <p>{entry.description} · Release {entry.revision}</p><RewardBindingSummary client={client} binding={entry} />
    </> : selectedId ? <p role="status">{selected.error ? "This combination is unavailable." : "Loading combination…"}</p> : <>
      <p className="models-catalog-description">Named grader combinations published in this workspace{resources.loading ? "" : ` · ${matches.length}`}.</p>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Combination</th><th>Sources</th><th>Release</th></tr></thead><tbody>{rows.map((binding) => <tr key={binding.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(binding.id)}><strong>{binding.name}</strong><small>{binding.description}</small></button></td><td>{binding.sources.length}</td><td>{binding.revision}</td></tr>)}</tbody></table></div>
      {resources.loading ? <p role="status">Loading combinations…</p> : !rows.length ? <p>No reusable combinations on this page.</p> : null}
      <LearningPager after={after} next={next} onPage={onPage} />
      <details><summary>Saved drafts</summary><AuthoringDraftList client={client} targetKind="binding" onResume={setResuming} /></details>
    </>}
    {resumeDialog}
    {editDialog}
  </div>;
}
