import { useState } from "react";
import { type OpenPondLearningClient, type TaskEvidence, type TaskFeedback, type LearningRevisionRef } from "openpond-sdk/learning";
import { AppDialog } from "../../dialogs/AppDialog";
import { LearningError } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";
import { RewardEditor } from "./RewardEditor";

export function RatingRewardAction({ client, evidence, feedback }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; feedback: TaskFeedback }) {
  const [expanded, setExpanded] = useState(false);
  if (feedback.submission.expectedEvidenceHash !== evidence.contentHash || !evidence.submission.observedOutput) return null;
  return expanded ? <RatingRewardChoices client={client} evidence={evidence} feedback={feedback} /> : <button type="button" className="training-button secondary" onClick={() => setExpanded(true)}>Use label to check Reward</button>;
}

function RatingRewardChoices({ client, evidence, feedback }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; feedback: TaskFeedback }) {
  const definition = useLearningResource(client, "definition", evidence.submission.taskDefinition.id, evidence.submission.taskDefinition.revision);
  const binding = useLearningResource(client, "binding", definition.resource?.rewardBinding.id ?? null, definition.resource?.rewardBinding.revision);
  const [editing, setEditing] = useState<LearningRevisionRef | "new" | null>(null);
  const [notice, setNotice] = useState("");
  if (feedback.submission.expectedEvidenceHash !== evidence.contentHash || !evidence.submission.observedOutput) return null;
  return <div><LearningError error={definition.error ?? binding.error} />
    {binding.resource?.sources.map(source => <button key={source.graderId} type="button" className="training-button secondary" onClick={() => setEditing(source.reward)}>Check / refine {source.graderId} with this label</button>)}
    {binding.resource && !binding.resource.sources.length ? <button type="button" className="training-button secondary" onClick={() => setEditing("new")}>Create Reward from this label</button> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {editing ? <AppDialog ariaLabel="Reward from label" className="labs-rename-dialog labs-model-taskset-dialog learning-editor-dialog" backdropClassName="labs-rename-backdrop" dismissDisabled onClose={() => undefined}>
      <RatingRewardEditor client={client} evidence={evidence} feedback={feedback} rewardRef={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={(id, revision) => { setEditing(null); setNotice(`Saved Reward ${id} · revision ${revision} with this label as a fixture. Existing task bindings retain their selected release.`); }} />
    </AppDialog> : null}
  </div>;
}

function RatingRewardEditor({ client, evidence, feedback, rewardRef, onClose, onSaved }: { client: OpenPondLearningClient | null; evidence: TaskEvidence; feedback: TaskFeedback; rewardRef: LearningRevisionRef | null; onClose: () => void; onSaved: (id: string, revision: number) => void }) {
  const reward = useLearningResource(client, "reward", rewardRef?.id ?? null, rewardRef?.revision);
  if (rewardRef && !reward.resource) return <div><LearningError error={reward.error} /><p>Loading the Reward selected by this task…</p><button type="button" className="training-button secondary" onClick={onClose}>Close</button></div>;
  return <RewardEditor client={client} reward={reward.resource} fromLabel={{ evidence, feedback }} onClose={onClose} onSaved={saved => onSaved(saved.id, saved.revision)} />;
}
