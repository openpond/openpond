import { RewardBindingSchema, RewardReleaseSchema, TaskDefinitionSchema, type AuthoringDraft, type OpenPondLearningClient } from "openpond-sdk/learning";
import { LearningError } from "./LearningFields";
import { useLearningResource } from "./useLearningResources";
import { TaskFormatEditor } from "./TaskFormatEditor";
import { RewardEditor } from "./RewardEditor";
import { CombinedRewardEditor } from "./CombinedRewardEditor";

export function AuthoringDraftEditor({ client, draft, onClose, onPublished }: { client: OpenPondLearningClient | null; draft: AuthoringDraft; onClose: () => void; onPublished: (id: string) => void }) {
  const base = useLearningResource(client, draft.targetKind, draft.baseRelease?.id ?? null, draft.baseRelease?.revision);
  if (draft.baseRelease && !base.resource) return <div className="learning-workspace"><LearningError error={base.error} /><p role="status">{base.error ? "The draft’s base release is unavailable." : "Loading the draft’s exact base release…"}</p><button type="button" className="training-button secondary" onClick={onClose}>Back</button></div>;
  if (draft.targetKind === "definition") return <TaskFormatEditor client={client} authoringDraft={draft} definition={base.resource ? TaskDefinitionSchema.parse(base.resource) : null} onClose={onClose} onSaved={value => onPublished(value.id)} />;
  if (draft.targetKind === "reward") return <RewardEditor client={client} authoringDraft={draft} reward={base.resource ? RewardReleaseSchema.parse(base.resource) : null} onClose={onClose} onSaved={value => onPublished(value.id)} />;
  return <CombinedRewardEditor client={client} authoringDraft={draft} binding={base.resource ? RewardBindingSchema.parse(base.resource) : null} onClose={onClose} onSaved={value => onPublished(value.id)} />;
}
