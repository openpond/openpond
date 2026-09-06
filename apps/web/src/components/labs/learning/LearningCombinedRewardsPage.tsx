import { useState } from "react";
import type { OpenPondLearningClient, RewardBinding } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { CombinedRewardEditor } from "./CombinedRewardEditor";
import { LearningActions, LearningError, LearningPager } from "./LearningFields";
import { RewardBindingSummary } from "./RewardBindingSummary";
import { useLearningResource, useLearningResources } from "./useLearningResources";

export function LearningCombinedRewardsPage({ client, selectedId, after, onSelect, onPage }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (after: string | null) => void }) {
  const resources = useLearningResources(client, "binding", { limit: 30, ...(after ? { afterId: after } : {}) });
  const [editing, setEditing] = useState<RewardBinding | "new" | null>(null);
  const selected = useLearningResource(client, "binding", selectedId);
  const entry = selected.resource ?? resources.page?.items.find((item) => item.id === selectedId) ?? null;
  if (editing) return <CombinedRewardEditor key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} client={client} binding={editing === "new" ? null : editing} onSaved={(binding) => { setEditing(null); selected.refresh(); resources.refresh(); onSelect(binding.id); }} onClose={() => setEditing(null)} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={entry?.name ?? "Combined Rewards"} description="Reusable combinations of exact Reward releases, weights and gates. Select a combination while creating or editing a task format." actions={<button type="button" className="training-button" onClick={() => setEditing("new")}>New combined Reward</button>} />
    <LearningError error={resources.error ?? selected.error} />
    {entry ? <>
      <LearningActions><button className="training-button secondary" type="button" onClick={() => onSelect(null)}>All combined Rewards</button><button className="training-button" type="button" onClick={() => setEditing(entry)}>Edit as next release</button></LearningActions>
      <p>{entry.description} · Release {entry.revision}</p><RewardBindingSummary client={client} binding={entry} />
    </> : selectedId ? <p role="status">{selected.error ? "This combined Reward is unavailable." : "Loading combined Reward…"}</p> : <>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Combination</th><th>Sources</th><th>Release</th></tr></thead><tbody>{resources.page?.items.filter((binding) => binding.name).map((binding) => <tr key={binding.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(binding.id)}><strong>{binding.name}</strong><small>{binding.description}</small></button></td><td>{binding.sources.length}</td><td>{binding.revision}</td></tr>)}</tbody></table></div>
      {resources.loading ? <p role="status">Loading combinations…</p> : !resources.page?.items.some((binding) => binding.name) ? <p>No reusable combinations on this page.</p> : null}
      <LearningPager after={after} next={resources.page?.nextCursor} onPage={onPage} />
    </>}
  </div>;
}
