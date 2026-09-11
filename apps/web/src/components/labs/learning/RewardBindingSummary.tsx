import type { OpenPondLearningClient } from "openpond-sdk/learning";
import type { RewardBinding, RewardBindingSource } from "openpond-sdk/learning";
import { LearningError } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";
import { RewardImplementationDetails } from "./RewardImplementationDetails";

export function RewardBindingSummary({ client, binding }: { client: OpenPondLearningClient | null; binding: RewardBinding }) {
  return <section aria-label="Reward combination"><div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Reward release</th><th>Role</th><th>Weight</th><th>Required</th><th>Hard gate</th><th>Direction</th></tr></thead><tbody>{binding.sources.map((source) => <SummarySource key={source.graderId} client={client} source={source} />)}</tbody></table></div></section>;
}
function SummarySource({ client, source }: { client: OpenPondLearningClient | null; source: RewardBindingSource }) {
  const resource = useLearningResource(client, "reward", source.reward.id, source.reward.revision);
  return <><tr><td>{resource.resource?.name ?? source.reward.id} · r{source.reward.revision}<LearningError error={resource.error} /></td><td>{source.role}</td><td>{source.weight}</td><td>{source.required ? "Yes" : "No"}</td><td>{source.hardGate ? "Yes" : "No"}</td><td>{source.normalization.kind === "linear" && source.normalization.direction === "lower" ? "Lower is better" : "Higher is better"}</td></tr>{resource.resource ? <tr><td colSpan={6}><details><summary>Inspect grader · {resource.resource.name}</summary><RewardImplementationDetails client={client} reward={resource.resource} /></details></td></tr> : null}</>;
}
