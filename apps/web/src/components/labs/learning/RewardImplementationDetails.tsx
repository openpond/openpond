import { verifyLearningTextAsset, type RewardRelease } from "openpond-sdk/learning";
import type { OpenPondLearningClient as LearningClient } from "openpond-sdk/learning";
import { LearningError, LearningValue } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";

export function RewardImplementationDetails({ client, reward }: { client: LearningClient | null; reward: RewardRelease }) {
  const implementation = reward.implementation;
  const reference = "verifierRef" in implementation ? implementation.verifierRef : "rubricRef" in implementation ? implementation.rubricRef : "inputContract" in implementation ? implementation.inputContract : null;
  const asset = useLearningResource(client, "asset", reference?.id ?? null, 1);
  let text: string | null = null;
  let error = asset.error;
  try { if (asset.resource && reference) text = verifyLearningTextAsset(asset.resource, reference); }
  catch (failure) { error = failure instanceof Error ? failure.message : "Unable to verify the grader source."; }
  const label = implementation.kind === "human" ? "Human review rubric" : implementation.kind === "model_judge" ? "LLM judge rubric" : implementation.kind === "custom_verifier" ? "Verifier code" : "Grading method";
  return <section className="learning-review-surface"><h2>{label}</h2><LearningError error={error} />
    {reference ? text !== null ? <pre>{text}</pre> : !error ? <p role="status">Loading grader source…</p> : null : <LearningValue label="Checks" value={implementation} />}
    {implementation.kind === "model_judge" ? <><LearningValue label="Judge model" value={implementation.model} /><p>Calibration: {implementation.calibrationStatus}</p></> : null}
    {implementation.kind === "human" ? <p>People apply this rubric. It does not run an automated model check.</p> : null}
    <p>Score range: {reward.rawScore.minimum}–{reward.rawScore.maximum} · Release {reward.revision}</p>
    <details><summary>Exact release and score contract</summary><LearningValue label="Release" value={{ id: reward.id, revision: reward.revision, contentHash: reward.contentHash }} /><LearningValue label="Implementation" value={implementation} /><LearningValue label="Score contract" value={reward.rawScore} /></details>
  </section>;
}
