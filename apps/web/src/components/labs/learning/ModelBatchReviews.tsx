import { useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import type { OpenPondLearningClient } from "openpond-sdk/learning";
import type { useTraining } from "../../../hooks/useTraining";
import { LearningError, LearningPager } from "./LearningFields";
import { useLearningClient, useLearningResources } from "./useLearningResources";

export function ModelBatchReviews({ model, training, onReview }: {
  model: ModelProject; training: ReturnType<typeof useTraining>; onReview: (evidenceId: string) => void;
}) {
  const client = useLearningClient(training.connection, model.profileId);
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const sources = useLearningResources(client, "source", { parentId: model.id, limit: 20, ...(after ? { afterId: after } : {}) });
  return <section className="learning-workspace" aria-label="Batch revisions">
    <h2>Batch revisions</h2>
    <p>Resume saved edits and review their examples. Attach an approved batch when it is ready to use.</p>
    <LearningError error={sources.error} />
    {sources.loading ? <p role="status">Loading revisions…</p> : !sources.page?.items.length ? <p>No saved batch revisions for this Model.</p> : null}
    {sources.page?.items.map((source) => <div key={source.id}>
      <button type="button" className="training-button secondary" aria-expanded={selected === source.id} onClick={() => setSelected(selected === source.id ? null : source.id)}>{source.name}</button>
      {selected === source.id ? <ReviewExamples key={source.id} client={client} sourceId={source.id} onReview={onReview} /> : null}
    </div>)}
    <LearningPager after={after} next={sources.page?.nextCursor} onPage={(cursor) => { setSelected(null); setAfter(cursor); }} />
  </section>;
}

function ReviewExamples({ client, sourceId, onReview }: { client: OpenPondLearningClient | null; sourceId: string; onReview: (id: string) => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const evidence = useLearningResources(client, "evidence", { parentId: sourceId, limit: 30, ...(after ? { afterId: after } : {}) });
  return <div>
    <LearningError error={evidence.error} />
    {evidence.loading ? <p role="status">Loading examples…</p> : null}
    <ul>{evidence.page?.items.map((entry) => <li key={entry.id}><button type="button" className="labs-version-row-button" onClick={() => onReview(entry.id)}>{entry.submission.exampleId} · {entry.submission.split}</button></li>)}</ul>
    <LearningPager after={after} next={evidence.page?.nextCursor} onPage={setAfter} />
  </div>;
}
