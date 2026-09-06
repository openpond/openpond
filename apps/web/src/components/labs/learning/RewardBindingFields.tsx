import { useState } from "react";
import { learningRef, type OpenPondLearningClient, type RewardBindingSource, type RewardRelease } from "openpond-sdk/learning";
import { LearningActions, LearningError, LearningPager } from "./LearningFields";
import { useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";

export function rewardBindingSource(reward: RewardRelease): RewardBindingSource {
  return { graderId: `grader-${crypto.randomUUID()}`, reward: learningRef(reward), role: reward.implementation.kind === "human" ? "evaluation" : "training", normalization: reward.rawScore.minimum === 0 && reward.rawScore.maximum === 1 ? { kind: "identity" } : { kind: "linear", ...reward.rawScore, direction: "higher" }, weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] };
}

export function RewardBindingFields({ client, sources, onChange }: { client: OpenPondLearningClient | null; sources: RewardBindingSource[]; onChange: (sources: RewardBindingSource[]) => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const rewards = useLearningResources(client, "reward", { limit: 30, ...(after ? { afterId: after } : {}) });
  return <section className="learning-binding-fields" aria-label="Reward sources">
    <h3>Reward sources</h3>
    <p>Training and evaluation scores are calculated separately as weighted means. A failed hard gate sets its role’s score to zero. Missing required results make that role unscorable; missing optional results are excluded.</p>
    {sources.map((source, index) => <BoundSource key={source.graderId} client={client} source={source} onChange={(next) => onChange(sources.map((item, position) => position === index ? next : item))} onRemove={() => onChange(sources.filter((_, position) => position !== index))} />)}
    <details open={!sources.length}><summary>Add a published Reward</summary>
      <LearningError error={rewards.error} />
      <label>Filter this page<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="learning-actions">{rewards.page?.items.filter((reward) => `${reward.name} ${reward.description}`.toLowerCase().includes(search.toLowerCase())).map((reward) => <button key={reward.id} type="button" className="training-button secondary" disabled={sources.length >= 100} onClick={() => onChange([...sources, rewardBindingSource(reward)])}>{reward.name} · release {reward.revision}</button>)}</div>
      {rewards.loading ? <p role="status">Loading Rewards…</p> : !rewards.page?.items.length ? <p>Publish a Reward in the Rewards library to add it here.</p> : null}
      <LearningPager after={after} next={rewards.page?.nextCursor} onPage={setAfter} />
    </details>
  </section>;
}

function BoundSource({ client, source, onChange, onRemove }: { client: OpenPondLearningClient | null; source: RewardBindingSource; onChange: (source: RewardBindingSource) => void; onRemove: () => void }) {
  const exact = useLearningResource(client, "reward", source.reward.id, source.reward.revision);
  const [release, setRelease] = useState(String(source.reward.revision));
  const mutation = useLearningMutation(client);
  const reward = exact.resource;
  const patch = (change: Partial<RewardBindingSource>) => onChange({ ...source, ...change });
  return <fieldset className="learning-bound-source">
    <legend>{reward?.name ?? source.reward.id} · release {source.reward.revision}</legend>
    <LearningError error={exact.error ?? mutation.error} />
    <div className="learning-binding-grid">
      <label>Role<select value={source.role} onChange={(event) => patch({ role: event.target.value as RewardBindingSource["role"] })}><option value="training" disabled={reward?.implementation.kind === "human"}>Training</option><option value="evaluation">Evaluation</option></select></label>
      <label>Weight<input type="number" min={0} max={1000} step="any" value={source.weight} onChange={(event) => patch({ weight: Number(event.target.value) })} /></label>
      <label>Score direction<select value={source.normalization.kind === "identity" ? "higher" : source.normalization.direction} disabled={!reward} onChange={(event) => { if (reward) patch({ normalization: { kind: "linear", ...reward.rawScore, direction: event.target.value as "higher" | "lower" } }); }}><option value="higher">Higher is better</option><option value="lower">Lower is better</option></select><small>{reward ? `Raw scores ${reward.rawScore.minimum}–${reward.rawScore.maximum} become 0–1 before combining.` : "Loading score contract…"}</small></label>
      <label>Exact release<input type="number" min={1} step={1} value={release} onChange={(event) => setRelease(event.target.value)} /><button className="training-button secondary" type="button" disabled={mutation.busy || Number(release) === source.reward.revision} onClick={async () => { const selected = await mutation.run((api) => api.get("reward", source.reward.id, Number(release))); if (selected) { const defaults = rewardBindingSource(selected); patch({ reward: defaults.reward, normalization: defaults.normalization, ...(selected.implementation.kind === "human" ? { role: "evaluation" } : {}) }); } }}>Use release</button></label>
    </div>
    <LearningActions>
      <label><input type="checkbox" checked={source.required} onChange={(event) => patch({ required: event.target.checked, ...(!event.target.checked ? { hardGate: false } : {}) })} /> Required result</label>
      <label><input type="checkbox" checked={source.hardGate} onChange={(event) => patch({ hardGate: event.target.checked, ...(event.target.checked ? { required: true } : {}) })} /> Hard gate</label>
      <button type="button" className="training-button secondary" onClick={onRemove}>Remove source</button>
    </LearningActions>
    <details><summary>Release identity</summary><small>{source.graderId} · {source.reward.contentHash}</small></details>
  </fieldset>;
}
