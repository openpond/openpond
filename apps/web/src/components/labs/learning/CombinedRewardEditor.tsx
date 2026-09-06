import { useState } from "react";
import { RewardBindingContentSchema, RewardBindingSchema, sealLearningContent, type OpenPondLearningClient, type RewardBinding, type RewardBindingSource } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError } from "./LearningFields";
import { RewardBindingFields } from "./RewardBindingFields";
import { useLearningMutation } from "./useLearningResources";

export function CombinedRewardEditor({ client, binding, onSaved, onClose }: { client: OpenPondLearningClient | null; binding: RewardBinding | null; onSaved: (binding: RewardBinding) => void; onClose: () => void }) {
  const [id] = useState(() => binding?.id ?? `recipe-${crypto.randomUUID()}`);
  const initial = { name: binding?.name ?? "", description: binding?.description ?? "", sources: binding?.sources ?? [] as RewardBindingSource[] };
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [revision, setRevision] = useState(binding?.revision ?? 0);
  const mutation = useLearningMutation(client);
  async function save() {
    const result = await mutation.run(async (api) => {
      const content = RewardBindingContentSchema.parse({ schemaVersion: "openpond.rewardBinding.v1", id, revision: revision + 1, ...draft, aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" });
      const response = await api.command({ action: "publish", operationId: `binding:${sealLearningContent(content).contentHash}`, kind: "binding", expectedRevision: revision, content });
      return RewardBindingSchema.parse(response.resources[0]);
    });
    if (result) { setRevision(result.revision); setSaved(JSON.stringify(draft)); }
    return result;
  }
  const guard = useDraftNavigation({ name: "combined Reward", dirty: saved !== JSON.stringify(draft), busy: mutation.busy, save: async () => Boolean(await save()) });
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={binding ? "Edit combined Reward" : "New combined Reward"} description="Publish a reusable combination. Task formats copy these defaults into their own binding; existing formats keep their selected releases." />
    <LearningError error={mutation.error} />
    <label>Name<input maxLength={500} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
    <label>Description<textarea maxLength={10_000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
    <RewardBindingFields client={client} sources={draft.sources} onChange={(sources) => setDraft({ ...draft, sources })} />
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button type="button" className="training-button" disabled={mutation.busy || !draft.name.trim() || !draft.sources.length} onClick={async () => { const result = await save(); if (result) { guard.allowNextNavigation(); onSaved(result); } }}>{mutation.busy ? "Publishing…" : `Publish release ${revision + 1}`}</button></LearningActions>
    {guard.dialog}
  </div>;
}
