import type { Taskset } from "@openpond/contracts";
import { RewardBindingSchema, type OpenPondLearningClient } from "openpond-sdk/learning";
import { RewardBindingSummary } from "./learning/RewardBindingSummary";

export function ModelCreationReward({ client, taskset }: { client: OpenPondLearningClient | null; taskset: Taskset }) {
  const learning = taskset.metadata.learning;
  const binding = RewardBindingSchema.safeParse(learning && typeof learning === "object" && "binding" in learning ? learning.binding : null);
  return <section className="learning-workspace">
    <h3>Quality checks for {taskset.name}</h3>
    <p>These Rewards belong to the selected Taskset release. Changing them requires publishing a new Taskset release; existing models keep their selected configuration.</p>
    {binding.success ? <RewardBindingSummary client={client} binding={binding.data} /> : taskset.graders.length ? taskset.graders.map((grader) => <details key={grader.id}><summary>{grader.label} · {grader.kind === "model_judge" ? "LLM judge" : grader.kind === "human" ? "Human review" : "Code verifier"}</summary><p>{grader.rewardEligible ? "Training Reward" : "Evaluation only"} · weight {grader.weight}{grader.hardGate ? " · hard gate" : ""}</p>{grader.kind === "model_judge" ? <><p>{grader.judge.providerId} / {grader.judge.modelId} · calibration {grader.calibrationStatus}</p><pre>{grader.rubric}</pre></> : grader.kind === "human" ? <pre>{grader.rubric}</pre> : grader.kind === "custom_verifier" ? <p>Source: {grader.module} · export {grader.exportName} · {grader.timeoutMs} ms limit</p> : <pre>{JSON.stringify(grader.config, null, 2)}</pre>}</details>) : <p>No Rewards are configured in this release. Add quality checks in Tasksets before reward-based training.</p>}
    {taskset.readiness ? <details><summary>Latest Taskset readiness</summary><ul>{[...taskset.readiness.blockers, ...taskset.readiness.warnings].map((finding, index) => <li key={index}>{typeof finding === "string" ? finding : finding.message}</li>)}</ul></details> : null}
  </section>;
}
