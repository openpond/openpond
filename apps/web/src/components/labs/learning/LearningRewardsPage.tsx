import { useState } from "react";
import type { OpenPondLearningClient, RewardRelease } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningPager, LearningValue } from "./LearningFields";
import { useLearningResource, useLearningResources } from "./useLearningResources";
import { RewardEditor } from "./RewardEditor";

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
