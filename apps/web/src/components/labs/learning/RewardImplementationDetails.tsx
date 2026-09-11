import { verifyLearningTextAsset, type RewardRelease } from "openpond-sdk/learning";
import type { OpenPondLearningClient as LearningClient } from "openpond-sdk/learning";
import { LearningError, LearningValue } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";
import { LearningDetailsTable } from "./LearningDetailsTable";
import { ReadableTaskValue } from "../ReadableTaskValue";

export function graderImplementationLabel(reward: RewardRelease): string {
  const labels: Record<RewardRelease["implementation"]["kind"], string> = { custom_verifier: "Code verifier", model_judge: "LLM judge", human: "Human review", learned_model: "Reward model", state: "Exact fields", content: "Text answer", schema: "Output schema", artifact: "Artifact reference", runtime_event: "Runtime events" };
  return labels[reward.implementation.kind];
}

export function RewardImplementationDetails({ client, reward }: { client: LearningClient | null; reward: RewardRelease }) {
  const implementation = reward.implementation;
  const reference = "verifierRef" in implementation ? implementation.verifierRef : "rubricRef" in implementation ? implementation.rubricRef : "inputContract" in implementation ? implementation.inputContract : null;
  const asset = useLearningResource(client, "asset", reference?.id ?? null, 1);
  let text: string | null = null;
  let error = asset.error;
  try { if (asset.resource && reference) text = verifyLearningTextAsset(asset.resource, reference); }
  catch (failure) { error = failure instanceof Error ? failure.message : "Unable to verify the grader source."; }
  const label = implementation.kind === "human" ? "Human review rubric" : implementation.kind === "model_judge" ? "LLM judge rubric" : implementation.kind === "custom_verifier" ? "Verifier code" : "Grading method";
  return <section className="learning-review-surface space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2>{label}</h2><span className="text-xs text-muted-foreground">{graderImplementationLabel(reward)} · Version {reward.revision}</span></div><LearningError error={error} />
    {reference ? text !== null ? <pre>{text}</pre> : !error ? <p role="status">Loading grader source…</p> : null : <LearningValue label="Checks" value={implementation} />}
    {implementation.kind === "model_judge" ? <><LearningValue label="Judge model" value={implementation.model} /><p>Calibration: {implementation.calibrationStatus}</p></> : null}
    {implementation.kind === "human" ? <p>People apply this rubric. It does not run an automated model check.</p> : null}
    <p>Score range: {reward.rawScore.minimum}–{reward.rawScore.maximum} · Release {reward.revision}</p>
    <details><summary>Exact release and score contract</summary><div className="mt-3"><LearningDetailsTable rows={[["Release", <ReadableTaskValue key="release" value={{ id: reward.id, revision: reward.revision, contentHash: reward.contentHash }} />], ["Implementation", <ReadableTaskValue key="implementation" value={implementation} />], ["Score contract", <ReadableTaskValue key="score" value={reward.rawScore} />]]} /></div></details>
  </section>;
}
