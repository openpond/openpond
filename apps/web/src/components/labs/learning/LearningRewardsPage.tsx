import { useState } from "react";
import { RewardReleaseContentSchema, RewardReleaseSchema, type OpenPondLearningClient, type RewardRelease } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningJsonField, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { learningOperationId, useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";

export function LearningRewardsPage({ client, selectedId, after, onSelect, onPage }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (after: string | null) => void }) {
  const resources = useLearningResources(client, "reward", { limit: 30, ...(after ? { afterId: after } : {}) });
  const [editing, setEditing] = useState<RewardRelease | "new" | null>(null);
  const selected = useLearningResource(client, "reward", selectedId);
  const entry = selected.resource ?? resources.page?.items.find((item) => item.id === selectedId) ?? null;
  if (editing) return <RewardEditor key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} client={client} reward={editing === "new" ? null : editing} onSaved={(reward) => { setEditing(null); selected.refresh(); resources.refresh(); onSelect(reward.id); }} onClose={() => setEditing(null)} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={entry?.name ?? "Rewards"} description="Publish reusable graders. Task formats bind exact releases, weights, and training or evaluation roles." actions={<button type="button" className="training-button" onClick={() => setEditing("new")}>New Reward</button>} />
    <LearningError error={resources.error ?? selected.error} />
    {entry ? <>
      <LearningActions><button className="training-button secondary" type="button" onClick={() => onSelect(null)}>All Rewards</button><button className="training-button" type="button" onClick={() => setEditing(entry)}>Edit as next release</button></LearningActions>
      <p>{entry.description}</p><p>Release {entry.revision} · {entry.contentHash}</p><LearningValue label="Grader implementation" value={entry.implementation} /><LearningValue label="Raw score contract" value={entry.rawScore} />
      <p>To try this Reward, bind it to a task format, import a sample, and run its grader in the review queue. Publishing alone records no passing result.</p>
    </> : selectedId ? <div role="status"><p>{selected.error ? "This Reward is unavailable." : "Loading Reward…"}</p><button type="button" className="training-button secondary" onClick={() => onSelect(null)}>All Rewards</button></div> : <>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Reward</th><th>Implementation</th><th>Release</th><th>Raw score</th></tr></thead><tbody>{resources.page?.items.map((reward) => <tr key={reward.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(reward.id)}><strong>{reward.name}</strong><small>{reward.description}</small></button></td><td>{reward.implementation.kind}</td><td>{reward.revision}</td><td>{reward.rawScore.minimum}–{reward.rawScore.maximum}</td></tr>)}</tbody></table></div>
      {resources.loading ? <p role="status">Loading Rewards…</p> : !resources.page?.items.length ? <p>No reusable Rewards have been published in this workspace.</p> : null}
      <LearningPager after={after} next={resources.page?.nextCursor} onPage={onPage} />
    </>}
  </div>;
}

function RewardEditor({ client, reward, onSaved, onClose }: { client: OpenPondLearningClient | null; reward: RewardRelease | null; onSaved: (reward: RewardRelease) => void; onClose: () => void }) {
  const [id] = useState(() => reward?.id ?? `reward-${crypto.randomUUID()}`);
  const initial = { name: reward?.name ?? "", description: reward?.description ?? "", implementation: JSON.stringify(reward?.implementation ?? { kind: "state", config: { fields: ["answer"] } }, null, 2), minimum: reward?.rawScore.minimum ?? 0, maximum: reward?.rawScore.maximum ?? 1 };
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [revision, setRevision] = useState(reward?.revision ?? 0);
  const mutation = useLearningMutation(client);
  const patch = (update: Partial<typeof draft>) => setDraft((value) => ({ ...value, ...update }));
  async function save() {
    const result = await mutation.run(async (api) => {
      const content = RewardReleaseContentSchema.parse({ schemaVersion: "openpond.rewardRelease.v1", id, revision: revision + 1, name: draft.name, description: draft.description, implementation: parseLearningObject(draft.implementation), rawScore: { minimum: draft.minimum, maximum: draft.maximum }, assets: reward?.assets ?? [] });
      return RewardReleaseSchema.parse((await api.command({ action: "publish", operationId: learningOperationId(), kind: "reward", expectedRevision: revision, content })).resources[0]);
    });
    if (!result) return null;
    setRevision(result.revision); setSaved(JSON.stringify(draft)); return result;
  }
  const guard = useDraftNavigation({ name: "Reward", dirty: JSON.stringify(draft) !== saved, busy: mutation.busy, save: async () => Boolean(await save()) });
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={reward ? "Edit Reward" : "New Reward"} description="Each published release is immutable. Existing task formats keep their pinned release." />
    <LearningError error={mutation.error} />
    <label>Name<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
    <label>Description<textarea value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
    <LearningJsonField label="Grader implementation" value={draft.implementation} onChange={(implementation) => patch({ implementation })} hint="Use a portable deterministic, code, model-judge, human, or learned-model implementation. Execution depends on the selected host's capabilities." />
    <label>Raw minimum<input type="number" value={draft.minimum} onChange={(event) => patch({ minimum: event.target.valueAsNumber })} /></label><label>Raw maximum<input type="number" value={draft.maximum} onChange={(event) => patch({ maximum: event.target.valueAsNumber })} /></label>
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button type="button" className="training-button" disabled={mutation.busy || !draft.name.trim()} onClick={async () => { const result = await save(); if (result) { guard.allowNextNavigation(); onSaved(result); } }}>{mutation.busy ? "Publishing…" : `Publish release ${revision + 1}`}</button></LearningActions>
    {guard.dialog}
  </div>;
}
