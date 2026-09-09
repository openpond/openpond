import { useEffect, useState } from "react";
import type { ManagedTrainingRunEvidence } from "@openpond/contracts";
import type { TrainingEvaluationTaskPage } from "openpond-sdk/training";
import { api, type ClientConnection } from "../../api";

export function ManagedTrainingEvaluationResults({
  connection,
  jobId,
  evaluations,
}: {
  connection: ClientConnection | null;
  jobId: string;
  evaluations: ManagedTrainingRunEvidence["evaluations"];
}) {
  const [selection, setSelection] = useState<string | null>(null);
  const available = evaluations.filter((evaluation) => evaluation.reference);
  const selected =
    available.find((evaluation) => evaluation.reference?.id === selection) ??
    available.filter((evaluation) => evaluation.kind === "candidate").at(-1) ??
    available[0];
  if (!connection || !selected?.reference) return null;
  return (
    <section
      className="training-run-evaluation"
      aria-label="Retained evaluation answers"
    >
      <label className="training-taskset-selector">
        <span>Evaluation answers</span>
        <select
          value={selected.reference.id}
          onChange={(event) => setSelection(event.target.value)}
        >
          {available.map((evaluation) => (
            <option
              key={evaluation.reference!.id}
              value={evaluation.reference!.id}
            >
              {evaluation.kind === "baseline" ? "Baseline" : "Candidate"} ·
              policy {evaluation.policyVersion}
            </option>
          ))}
        </select>
      </label>
      <EvaluationPage
        key={`${jobId}:${selected.reference.id}:${selected.reference.contentHash}`}
        connection={connection}
        jobId={jobId}
        evaluation={selected.reference}
      />
    </section>
  );
}

function EvaluationPage({
  connection,
  jobId,
  evaluation,
}: {
  connection: ClientConnection;
  jobId: string;
  evaluation: { id: string; contentHash: string };
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [page, setPage] = useState<TrainingEvaluationTaskPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const { id, contentHash } = evaluation;
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setPage(null);
    void api
      .trainingEvaluationTasks(connection, jobId, { id, contentHash }, cursor)
      .then((value) => {
        if (current) setPage(value);
      })
      .catch((caught: unknown) => {
        if (current)
          setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [connection, jobId, id, contentHash, cursor, refresh]);

  return (
    <div className="training-run-evaluation" aria-busy={loading}>
      {loading ? (
        <p className="training-muted">Loading recorded answers…</p>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            className="training-button secondary"
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry answers
          </button>
        </div>
      ) : null}
      {page ? (
        <>
          <p className="training-muted">
            Tasks {page.offset + 1}–{page.offset + page.tasks.length} of{" "}
            {page.total}. Recorded outputs and scores are saved locally for this
            run.
          </p>
          {page.tasks.map((task, index) => (
            <details key={task.taskId} className="training-evidence">
              <summary>Example {page.offset + index + 1} · score {task.score.toFixed(3)}</summary>
              <div className="training-evaluation-output">
                <div>
                  <span>Instruction</span>
                  <pre>{task.input.instruction}</pre>
                </div>
                <div>
                  <span>Context</span>
                  <pre>
                    {JSON.stringify(task.input.context, null, 2)}
                  </pre>
                </div>
                <div>
                  <span>Recorded output</span>
                  <pre>{task.output}</pre>
                </div>
              </div>
            </details>
          ))}
        </>
      ) : null}
      <div className="training-dialog-actions">
        <button
          className="training-button secondary"
          type="button"
          disabled={loading || !history.length}
          onClick={() => {
            setCursor(history.at(-1));
            setHistory((previous) => previous.slice(0, -1));
          }}
        >
          Previous tasks
        </button>
        <button
          className="training-button secondary"
          type="button"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (!page?.nextCursor) return;
            setHistory((previous) => [...previous, cursor]);
            setCursor(page.nextCursor);
          }}
        >
          Next tasks
        </button>
      </div>
    </div>
  );
}
