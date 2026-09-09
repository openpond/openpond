import { useMemo, useState } from "react";
import type { createHostedModelLearningApi } from "../../../api/model-learning-api";
import { LearningReviewPage } from "./LearningReviewPage";
import { requestDesktopViewChange } from "../lab-primary-tab-state";

export function HostedModelLearningReview({ api, policyId, sourceId, onBack }: {
  api: ReturnType<typeof createHostedModelLearningApi>; policyId: string; sourceId: string; onBack: () => void;
}) {
  const client = useMemo(() => api.reviewClient(policyId, sourceId), [api, policyId, sourceId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  return <section aria-label="Hosted example review">
    <button type="button" className="training-button secondary" onClick={() => { void requestDesktopViewChange(onBack); }}>Back to continual learning</button>
    <p>Reviewing hosted examples. Approved tasks become eligible for this policy's next training check.</p>
    <LearningReviewPage client={client} selectedId={selectedId} after={after} sourceId={sourceId} onSelect={id => { void requestDesktopViewChange(() => setSelectedId(id)); }} onPage={setAfter} />
  </section>;
}
