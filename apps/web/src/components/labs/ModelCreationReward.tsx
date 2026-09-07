import { useState } from "react";
import type { ModelProject, Taskset } from "@openpond/contracts";
import { learningRef, RewardBindingContentSchema, RewardBindingSchema, sealLearningContent, type RewardRelease, type OpenPondLearningClient } from "openpond-sdk/learning";
import { AppDialog } from "../dialogs/AppDialog";
import { RewardEditor } from "./learning/RewardEditor";
import { CombinedRewardEditor } from "./learning/CombinedRewardEditor";
import { rewardBindingSource } from "./learning/RewardBindingFields";
import { LearningError, LearningPager } from "./learning/LearningFields";
import { useLearningMutation, useLearningResource, useLearningResources } from "./learning/useLearningResources";
import { RewardBindingSummary } from "./learning/RewardBindingSummary";
import type { ModelStarterPreview } from "../../hooks/useTraining";

function TasksetRewardPreview({ client, taskset }: { client: OpenPondLearningClient | null; taskset: Taskset }) {
  const learning = taskset.metadata.learning;
  const binding = RewardBindingSchema.safeParse(learning && typeof learning === "object" && "binding" in learning ? learning.binding : null);
  return <section className="learning-workspace">
    <h3>Quality checks for {taskset.name}</h3>
    <p>These Rewards belong to the selected Taskset release. Changing them requires publishing a new Taskset release; existing models keep their selected configuration.</p>
    {binding.success ? <RewardBindingSummary client={client} binding={binding.data} /> : taskset.graders.length ? taskset.graders.map((grader) => <details key={grader.id}><summary>{grader.label} · {grader.kind === "model_judge" ? "LLM judge" : grader.kind === "human" ? "Human review" : "Code verifier"}</summary><p>{grader.rewardEligible ? "Training Reward" : "Evaluation only"} · weight {grader.weight}{grader.hardGate ? " · hard gate" : ""}</p>{grader.kind === "model_judge" ? <><p>{grader.judge.providerId} / {grader.judge.modelId} · calibration {grader.calibrationStatus}</p><pre>{grader.rubric}</pre></> : grader.kind === "human" ? <pre>{grader.rubric}</pre> : grader.kind === "custom_verifier" ? <p>Source: {grader.module} · export {grader.exportName} · {grader.timeoutMs} ms limit</p> : <pre>{JSON.stringify(grader.config, null, 2)}</pre>}</details>) : <p>No Rewards are configured in this release. Add quality checks in Tasksets before reward-based training.</p>}
    {taskset.readiness ? <details><summary>Latest Taskset readiness</summary><ul>{[...taskset.readiness.blockers, ...taskset.readiness.warnings].map((finding, index) => <li key={index}>{typeof finding === "string" ? finding : finding.message}</li>)}</ul></details> : null}
  </section>;
}

export function ModelCreationReward({ client, taskset, bindingRef, onChange, starter }: { client: OpenPondLearningClient | null; taskset: Taskset | null; bindingRef: ModelProject["trainingSetup"]["rewardBindingRef"]; onChange: (value: ModelProject["trainingSetup"]["rewardBindingRef"]) => void; starter?: ModelStarterPreview }) {
  const [after, setAfter] = useState<string | null>(null);
  const [editor, setEditor] = useState<"reward" | "combined" | null>(null);
  const bindings = useLearningResources(client, "binding", { limit: 30, ...(after ? { afterId: after } : {}) });
  const starterSelected = Boolean(starter && bindingRef?.id === starter.starter.rewardBinding.id && bindingRef?.revision === starter.starter.rewardBinding.revision && bindingRef?.contentHash === starter.starter.rewardBinding.contentHash);
  const selected = useLearningResource(client, "binding", starterSelected ? null : bindingRef?.id ?? null, bindingRef?.revision);
  const mutation = useLearningMutation(client);
  async function useReward(reward: RewardRelease) {
    const binding = await mutation.run(async (api) => {
      const source = { ...rewardBindingSource(reward), graderId: "primary" };
      const content = RewardBindingContentSchema.parse({ schemaVersion: "openpond.rewardBinding.v1", id: `model-reward-${reward.contentHash}`, revision: 1, name: reward.name, description: reward.description, sources: [source], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" });
      const response = await api.command({ action: "publish", operationId: `binding:${sealLearningContent(content).contentHash}`, kind: "binding", expectedRevision: 0, content });
      return RewardBindingSchema.parse(response.resources[0]);
    });
    if (binding) { onChange(learningRef(binding)); setEditor(null); bindings.refresh(); }
  }
  return <section className="learning-workspace model-creation-reward">
    <h3>Reward</h3><p>Choose or create quality checks now. You can import tasks later; their format must support the selected checks.</p>
    <LearningError error={bindings.error ?? selected.error ?? mutation.error} />
    <div className="labs-model-create-select-row"><select aria-label="Reward" value={bindingRef ? `${bindingRef.id}:${bindingRef.revision}` : ""} onChange={(event) => { if (starter && event.target.value === `${starter.starter.rewardBinding.id}:${starter.starter.rewardBinding.revision}`) { onChange(starter.starter.rewardBinding); return; } const binding = bindings.page?.items.find((item) => `${item.id}:${item.revision}` === event.target.value); onChange(binding ? learningRef(binding) : null); }}>
      <option value="">{taskset || starter ? "Use Taskset Reward" : "Choose later"}</option>
      {starter ? <option value={`${starter.starter.rewardBinding.id}:${starter.starter.rewardBinding.revision}`}>{starter.reward.name} · {starter.reward.checks.map(check => check.kind === "custom_verifier" ? "Code verifier" : check.kind === "model_judge" ? "LLM judge" : check.kind === "human" ? "Human review" : "Deterministic check").filter((kind, index, kinds) => kinds.indexOf(kind) === index).join(" + ")}</option> : null}
      {bindingRef && !starterSelected && !bindings.page?.items.some((item) => item.id === bindingRef.id && item.revision === bindingRef.revision) ? <option value={`${bindingRef.id}:${bindingRef.revision}`}>{selected.resource?.name || bindingRef.id} · release {bindingRef.revision}</option> : null}
      {bindings.page?.items.filter(binding => !starter || binding.id !== starter.starter.rewardBinding.id || binding.revision !== starter.starter.rewardBinding.revision).map((binding) => <option key={binding.id} value={`${binding.id}:${binding.revision}`}>{binding.name || binding.id} · release {binding.revision}</option>)}
    </select><button type="button" className="labs-model-create-add" aria-label="Create Reward" onClick={() => setEditor("reward")}>+</button></div>
    <LearningPager after={after} next={bindings.page?.nextCursor} onPage={setAfter} />
    <button type="button" className="training-button secondary" onClick={() => setEditor("combined")}>Combine Rewards</button>
    {selected.resource ? <RewardBindingSummary client={client} binding={selected.resource} /> : null}
    {starterSelected && starter ? <p>{starter.reward.description}</p> : null}
    {!bindingRef && taskset ? <TasksetRewardPreview client={client} taskset={taskset} /> : null}
    {editor ? <AppDialog ariaLabel={editor === "reward" ? "Create Reward" : "Combine Rewards"} className="labs-rename-dialog labs-model-taskset-dialog" backdropClassName="labs-rename-backdrop" dismissDisabled onClose={() => undefined}>
      {editor === "reward" ? <RewardEditor client={client} reward={null} onClose={() => setEditor(null)} onSaved={(reward) => { void useReward(reward); }} /> : <CombinedRewardEditor client={client} binding={null} onClose={() => setEditor(null)} onSaved={(binding) => { onChange(learningRef(binding)); setEditor(null); bindings.refresh(); }} />}
      <LearningError error={mutation.error} />
    </AppDialog> : null}
  </section>;
}
