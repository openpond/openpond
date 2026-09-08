import { useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import type { ModelBatchReviewInspection } from "openpond-sdk/model-batch-review";
import type { useTraining } from "../../../hooks/useTraining";
import { ModelBatchReviewDialog } from "./ModelBatchReviewDialog";
import { useLearningClient } from "./useLearningResources";

export function ModelBatchReviewAction({ model, training, onReview }: {
  model: ModelProject; training: ReturnType<typeof useTraining>; onReview: (evidenceId: string) => void;
}) {
  const client = useLearningClient(training.connection, model.profileId);
  const [value, setValue] = useState<ModelBatchReviewInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <><button type="button" className="training-button secondary" disabled={busy} onClick={async () => {
    setBusy(true); setError(null);
    try {
      const value = await training.actions.inspectModelBatch(model.id);
      setValue(value);
    } catch (error) { setError(error instanceof Error ? error.message : "The batch could not be opened."); }
    finally { setBusy(false); }
  }}>{busy ? "Opening…" : "Revise batch"}</button>{error ? <p role="alert">{error}</p> : null}
    {value ? <ModelBatchReviewDialog key={value.packageHash} model={model} value={value} client={client} onSave={training.actions.beginModelBatchReview} onClose={() => setValue(null)} onReview={onReview} /> : null}
  </>;
}
