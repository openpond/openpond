import { AppDialog } from "../../dialogs/AppDialog";
import { useState } from "react";
import type { AuthoringDraft } from "openpond-sdk/learning";
import { AuthoringDraftList } from "./AuthoringDraftList";
import { AuthoringDraftEditor } from "./AuthoringDraftEditor";
import type { OpenPondLearningClient, TaskDefinition } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningPager, LearningValue } from "./LearningFields";
import { useLearningResource, useLearningResources } from "./useLearningResources";
import { LearningIntake } from "./LearningIntake";
import { TaskFormatEditor } from "./TaskFormatEditor";
import { RewardBindingSummary } from "./RewardBindingSummary";
import { LearningSourceCredentials } from "./LearningSourceCredentials";

export function LearningTaskFormatsPage({ client, selectedId, after, onSelect, onPage, onReview }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (after: string | null) => void; onReview: (id: string) => void }) {
  const definitions = useLearningResources(client, "definition", { limit: 30, ...(after ? { afterId: after } : {}) });
  const [resuming, setResuming] = useState<AuthoringDraft | null>(null);
  const [editing, setEditing] = useState<TaskDefinition | "new" | null>(null);
  const selected = useLearningResource(client, "definition", selectedId);
  const definition = selected.resource ?? definitions.page?.items.find((item) => item.id === selectedId) ?? null;
  const binding = useLearningResource(client, "binding", definition?.rewardBinding.id ?? null, definition?.rewardBinding.revision);


  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={definition?.name ?? "Task formats"} description="Define input, output and grading once, then submit examples through JSON or the SDK. Formats are shared across models in this workspace." actions={<button type="button" className="training-button" onClick={() => setEditing("new")}>New task format</button>} />
    <LearningError error={definitions.error ?? selected.error} />
    {definition ? <>
      <LearningActions><button type="button" className="training-button secondary" onClick={() => onSelect(null)}>All task formats</button><button type="button" className="training-button" onClick={() => setEditing(definition)}>Edit as next release</button></LearningActions>
      <p>{definition.instructions}</p><p>Release {definition.revision} · {definition.contentHash}</p>
      <details><summary>Input and output contracts</summary><LearningValue label="Input schema" value={definition.inputSchema} /><LearningValue label="Output schema" value={definition.outputSchema} /></details>
      <LearningError error={binding.error} />{binding.resource ? <RewardBindingSummary client={client} binding={binding.resource} /> : null}
      <details><summary>Connect an application</summary><LearningSourceCredentials key={`${definition.id}:${definition.revision}`} client={client} sourceId={definition.revision === 1 ? `${definition.id}-direct` : `${definition.id}-r${definition.revision}-direct`} /></details>
      <LearningIntake key={`${definition.id}:${definition.revision}`} client={client} definition={definition} onReview={onReview} />
    </> : selectedId ? <><p role="status">{selected.error ? "This task format is unavailable." : "Loading task format…"}</p><button type="button" className="training-button secondary" onClick={() => onSelect(null)}>All task formats</button></> : <>
      <AuthoringDraftList client={client} targetKind="definition" onResume={setResuming} />
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Task format</th><th>Category</th><th>Release</th></tr></thead><tbody>{definitions.page?.items.map((definition) => <tr key={definition.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(definition.id)}><strong>{definition.name}</strong><small>{definition.description}</small></button></td><td>{definition.category}</td><td>{definition.revision}</td></tr>)}</tbody></table></div>
      {definitions.loading ? <p role="status">Loading task formats…</p> : !definitions.page?.items.length ? <p>Create a task format to accept structured examples and human corrections.</p> : null}<LearningPager after={after} next={definitions.page?.nextCursor} onPage={onPage} />
    </>}
    {resuming ? <AppDialog ariaLabel="Resume Task format" className="labs-rename-dialog labs-model-taskset-dialog learning-editor-dialog" backdropClassName="labs-rename-backdrop" dismissDisabled onClose={() => undefined}><AuthoringDraftEditor key={resuming.id} client={client} draft={resuming} onClose={() => setResuming(null)} onPublished={id => { setResuming(null); selected.refresh(); definitions.refresh(); onSelect(id); }} /></AppDialog> : null}
    {editing ? <AppDialog ariaLabel="Task format" className="labs-rename-dialog labs-model-taskset-dialog learning-editor-dialog" backdropClassName="labs-rename-backdrop" dismissDisabled onClose={() => undefined}><TaskFormatEditor key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} definition={editing === "new" ? null : editing} client={client} onClose={() => setEditing(null)} onSaved={(definition) => { setEditing(null); definitions.refresh(); selected.refresh(); onSelect(definition.id); }} /></AppDialog> : null}
  </div>;
}
