import { useRef, useState } from "react";
import {
  canonicalJson,
  parseDecisionFormScoring,
  type DecisionModelVersion,
  type DecisionExperimentFormDraft,
} from "openpond-sdk/training";
import { useDraftNavigation } from "./useDraftNavigation";
import { ErrorToast } from "../common/ErrorToast";
import { AppDialog } from "../dialogs/AppDialog";
import { DecisionScoringFields } from "./workspace/DecisionFields";
import { DecisionResults } from "./workspace/DecisionResults";
import { initialDecisionForm } from "./workspace/decision-form-defaults";
import { useScoreDecisionModel } from "./useScoreDecisionModel";
import type { WorkspaceApi } from "./workspace/workspace-api";
export function DecisionModelScoring({
  api,
  version,
  active,
}: {
  api: WorkspaceApi;
  version: DecisionModelVersion;
  active: boolean;
}) {
  const owner = useScoreDecisionModel(api, version.modelProjectId);
  const [form, setForm] = useState(
    () => initialDecisionForm("score") as Extract<DecisionExperimentFormDraft, { mode: "score" }>,
  );
  const baseline = useRef(canonicalJson(form));
  const guard = useDraftNavigation({
    name: "Decision scoring input",
    dirty: canonicalJson(form) !== baseline.current,
    busy: owner.busy,
  });
  const [review, setReview] = useState(false),
    [error, setError] = useState<unknown>(null);
  return (
    <section className="training-detail-section" aria-label="Score exact Decision Model">
      <h3>Score this version</h3>
      {guard.dialog}
      <ErrorToast error={error ?? owner.error} />
      {owner.original ? (
        <>
          <p className="saved-model-version-reference">
            Original scoring request retained for saved version{" "}
            {owner.original.command.request.versionHash}.
          </p>
          <details>
            <summary>Original scoring input and limits</summary>
            <pre>
              {JSON.stringify(
                {
                  input: owner.original.command.request.input,
                  limits: owner.original.command.request.limits,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      ) : null}
      <fieldset disabled={owner.busy || Boolean(owner.original)}>
        <DecisionScoringFields form={form} onChange={setForm} />
      </fieldset>
      <div className="model-build-actions">
        <button className="training-button secondary" onClick={owner.refresh} disabled={owner.busy}>
          Refresh scoring recovery
        </button>
        <button
          className="training-button"
          disabled={owner.busy || !owner.ready || (!owner.original && !active)}
          onClick={() => {
            if (owner.original) {
              void owner.run();
              return;
            }
            try {
              parseDecisionFormScoring(form);
              setError(null);
              setReview(true);
            } catch (cause) {
              setError(cause);
            }
          }}
        >
          {owner.original ? "Retry original score" : "Review score"}
        </button>
      </div>
      {owner.receipt ? (
        <>
          <p className="saved-model-version-reference">
            Recorded scores for saved version {owner.receipt.version.contentHash}.
          </p>
          <DecisionResults result={owner.receipt.result} />
        </>
      ) : null}
      {review ? (
        <AppDialog
          ariaLabel="Score exact Decision Model"
          className="labs-rename-dialog"
          backdropClassName="labs-rename-backdrop"
          dismissDisabled={owner.busy}
          onClose={() => {
            if (!owner.busy) setReview(false);
          }}
        >
          <h2>Score exact Decision Model</h2>
          <p>
            Score every allowed candidate using this saved adapter and the reviewed bounded limits.
          </p>
          <p className="saved-model-version-reference">{version.contentHash}</p>
          <pre>{JSON.stringify(parseDecisionFormScoring(form), null, 2)}</pre>
          <div className="model-build-actions">
            <button
              disabled={owner.busy}
              className="training-button secondary"
              onClick={() => setReview(false)}
            >
              Close
            </button>
            <button
              disabled={owner.busy || !owner.ready}
              className="training-button"
              onClick={() => {
                void owner
                  .run({
                    schemaVersion: "openpond.decisionModelScoreRequest.v1",
                    teamId: api.teamId,
                    versionHash: version.contentHash,
                    ...parseDecisionFormScoring(form),
                  })
                  .then((result) => {
                    if (result) {
                      baseline.current = canonicalJson(form);
                      setReview(false);
                    }
                  });
              }}
            >
              Score
            </button>
          </div>
        </AppDialog>
      ) : null}
    </section>
  );
}
