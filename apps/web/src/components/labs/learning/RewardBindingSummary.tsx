import type { OpenPondLearningClient, RewardBinding, RewardBindingSource } from "openpond-sdk/learning";
import { LearningError } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";

export function RewardBindingSummary({ client, binding }: { client: OpenPondLearningClient | null; binding: RewardBinding }) {
  return <section aria-label="Reward combination"><p>Weighted mean per role. Hard gates enforce a zero score when failed; required results must be available.</p><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Reward release</th><th>Role</th><th>Weight</th><th>Required</th><th>Hard gate</th><th>Direction</th></tr></thead><tbody>{binding.sources.map((source) => <SummarySource key={source.graderId} client={client} source={source} />)}</tbody></table></div><details><summary>Binding identity</summary><small>{binding.id} · release {binding.revision} · {binding.contentHash}</small>{binding.recipeRef ? <p>Initialized from combination {binding.recipeRef.id}, release {binding.recipeRef.revision}.</p> : null}</details></section>;
}
function SummarySource({ client, source }: { client: OpenPondLearningClient | null; source: RewardBindingSource }) {
  const resource = useLearningResource(client, "reward", source.reward.id, source.reward.revision);
  return <tr><td>{resource.resource?.name ?? source.reward.id} · r{source.reward.revision}<LearningError error={resource.error} /></td><td>{source.role}</td><td>{source.weight}</td><td>{source.required ? "Yes" : "No"}</td><td>{source.hardGate ? "Yes" : "No"}</td><td>{source.normalization.kind === "linear" && source.normalization.direction === "lower" ? "Lower is better" : "Higher is better"}</td></tr>;
}
