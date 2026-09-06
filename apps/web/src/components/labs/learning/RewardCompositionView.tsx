import { useState } from "react";
import type { BoundRewardResult, OpenPondLearningClient, RewardComposition } from "openpond-sdk/learning";
import { LearningError } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";

export function RewardCompositionDetails(props: { client: OpenPondLearningClient | null; composition: RewardComposition }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Reward breakdown</summary>{open ? <RewardCompositionView {...props} /> : null}</details>;
}
function RewardCompositionView({ client, composition }: { client: OpenPondLearningClient | null; composition: RewardComposition }) {
  const binding = useLearningResource(client, "binding", composition.binding.id, composition.binding.revision);
  return <section aria-label="Reward result breakdown">
    <LearningError error={binding.error} />
    <p>{(["training", "evaluation"] as const).filter((role) => composition[role].status !== "not_configured").map((role) => { const result = composition[role]; return `${role === "training" ? "Training" : "Evaluation"}: ${result.status === "scored" ? `${result.score} · ${result.passed ? "passed" : "failed"}` : result.status}`; }).join(" · ")}</p>
    <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Reward</th><th>Role</th><th>Result</th><th>Raw score</th><th>Normalized</th><th>Weight / gate</th><th>Feedback</th></tr></thead><tbody>{composition.results.map((result) => <ResultRow key={result.graderId} client={client} result={result} settings={binding.resource?.sources.find((source) => source.graderId === result.graderId)} />)}</tbody></table></div>
    <small>Binding release {composition.binding.revision} · receipt {composition.contentHash}</small>
  </section>;
}
function ResultRow({ client, result, settings }: { client: OpenPondLearningClient | null; result: BoundRewardResult; settings?: { weight: number; required: boolean; hardGate: boolean } }) {
  const reward = useLearningResource(client, "reward", result.reward.id, result.reward.revision);
  return <tr><td>{reward.resource?.name ?? result.reward.id} · r{result.reward.revision}<LearningError error={reward.error} /></td><td>{result.role}</td><td>{result.status === "scored" ? result.passed ? "Passed" : "Failed" : result.status}</td><td>{result.rawScore ?? "—"}</td><td>{result.normalizedScore ?? "—"}</td><td>{settings ? `${settings.weight}${settings.hardGate ? " · hard gate" : settings.required ? " · required" : " · optional"}` : "Loading…"}</td><td>{result.message ?? "—"}</td></tr>;
}
