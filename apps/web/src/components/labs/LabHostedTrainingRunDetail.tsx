import { TrainingRunDiagnostics } from "./workspace/TrainingRunDiagnostics";
import { contentHash } from "@openpond/harness";
import { PostTrainingControlSchema } from "openpond-sdk/post-training";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  TrainingJobSchema,
  TrainingJobEventSchema,
  TrainingJobOutputsSchema,
} from "openpond-sdk/training";
import { PostTrainingSummarySchema, postTrainingActive } from "openpond-sdk/post-training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";
import "./hosted-training-run.css";

const Detail = z
  .object({
    job: TrainingJobSchema,
    events: z.array(TrainingJobEventSchema).max(10_000),
    outputs: TrainingJobOutputsSchema,
    evals: PostTrainingSummarySchema.nullable(),
  })
  .strict();
type Value = z.infer<typeof Detail>;
export function LabHostedTrainingRunDetail({
  connection,
  teamId,
  actorId,
  retainOperation,
  jobId,
  onOpenExperiment,
  diagnostics=false,
  onDiagnostics,
}: {
  diagnostics?:boolean;
  onDiagnostics?:(value:boolean)=>void;
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  retainOperation: (
    action: string,
    intent: unknown,
  ) => Promise<{ id: string; acknowledge: () => Promise<void> }>;
  jobId: string;
  onOpenExperiment: (id: string) => void;
}) {
  const [refreshVersion,setRefreshVersion]=useState(0);
  const scope = JSON.stringify([connection.serverUrl, connection.token, teamId, actorId, jobId]);
  const [retained, setRetained] = useState<{ scope: string; value: Value } | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const recoveryKey = `openpond:run-eval-control:${contentHash({ apiOrigin: connection.serverUrl, teamId, actorId, jobId })}`;
  const pending = useRef<{
    action: "start" | "retry" | "cancel";
    control: z.infer<typeof PostTrainingControlSchema>;
  } | null>(null);
  useEffect(() => {
    activeScope.current = scope;
    pending.current = null;
    setBusy(false);
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (raw) {
        const parsed = z
          .object({
            action: z.enum(["start", "retry", "cancel"]),
            control: PostTrainingControlSchema,
          })
          .strict()
          .parse(JSON.parse(raw));
        pending.current = parsed;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Retained action is unavailable.");
    }
    return () => {
      activeScope.current = "unmounted";
    };
  }, [scope, recoveryKey]);
  const value = retained?.scope === scope ? retained.value : null;
  const path = `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}`;
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    setError(null);
    const read = async () => {
      try {
        const next = Detail.parse(
          await apiFetch(connection, `${path}?teamId=${encodeURIComponent(teamId)}`),
        );
        if (next.job.id !== jobId || next.job.teamId !== teamId)
          throw new Error("Training run scope changed.");
        if (!stopped) {
          setRetained({ scope, value: next });
          setError(null);
          const active =
            !["completed", "failed", "cancelled", "budget_exhausted"].includes(next.job.state) ||
            postTrainingActive(next.evals) ||
            next.evals?.state === "waiting_for_training";
          timer = setTimeout(read, active ? 3000 : 10000);
        }
      } catch (reason) {
        if (!stopped) {
          setError(reason instanceof Error ? reason.message : "Training run is unavailable.");
          timer = setTimeout(read, 5000);
        }
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [connection.serverUrl, connection.token, path, scope, teamId, actorId, jobId,refreshVersion]);
  async function control(action: "start" | "retry" | "cancel") {
    if (!value?.evals || busy) return;
    const callScope = scope,
      fence = () => {
        if (activeScope.current !== callScope)
          throw new Error("The current account or training run changed.");
      };
    setBusy(true);
    try {
      const old = pending.current;
      if (old && old.action !== action)
        throw new Error("Resolve the retained uncertain action first.");
      const intent = old
        ? {
            action: old.action,
            expectedRevision: old.control.expectedRevision,
            planHash: old.control.planHash,
          }
        : { action, expectedRevision: value.evals.revision, planHash: value.evals.planHash };
      const operation = await retainOperation("training:eval-control", {
        teamId,
        actorId,
        jobId,
        ...intent,
      });
      fence();
      const command = old ?? {
        action,
        control: {
          operationId: operation.id,
          expectedRevision: intent.expectedRevision,
          planHash: intent.planHash,
        },
      };
      localStorage.setItem(recoveryKey, JSON.stringify(command));
      if (localStorage.getItem(recoveryKey) !== JSON.stringify(command))
        throw new Error("Enable durable storage before controlling evaluations.");
      pending.current = command;
      const evals = PostTrainingSummarySchema.parse(
        await apiFetch(
          connection,
          `${path}/post-training/${command.action}?teamId=${encodeURIComponent(teamId)}`,
          { method: "POST", body: JSON.stringify(command.control) },
        ),
      );
      fence();
      if (
        evals.teamId !== teamId ||
        evals.jobId !== jobId ||
        evals.planHash !== command.control.planHash
      )
        throw new Error("The evaluation authority changed.");
      await operation.acknowledge();
      fence();
      localStorage.removeItem(recoveryKey);
      pending.current = null;
      setRetained({ scope, value: { ...value, evals } });
      setError(null);
    } catch (reason) {
      if (activeScope.current === callScope)
        setError(reason instanceof Error ? reason.message : "Evaluation command failed.");
    } finally {
      if (activeScope.current === callScope) setBusy(false);
    }
  }
  return (
    <div className="labs-flat-body labs-resource-page">
      <ModelProjectPageHeader title="Training run" description={jobId} />
      <nav className="evaluation-workspace-tabs" aria-label="Training sections"><button aria-selected={!diagnostics} onClick={()=>onDiagnostics?.(false)}>Overview</button><button aria-selected={diagnostics} onClick={()=>onDiagnostics?.(true)}>Diagnostics</button></nav>
      {error ? <p role="alert">{error}</p> : null}
      {pending.current ? (
        <button type="button" disabled={busy} onClick={() => void control(pending.current!.action)}>
          Retry retained {pending.current.action} action
        </button>
      ) : null}
      {value && diagnostics ? <TrainingRunDiagnostics job={value.job} events={value.events} onRefresh={()=>setRefreshVersion(version=>version+1)}/> : null}
      {!value ? (
        <p role="status">Loading training run…</p>
      ) : !diagnostics ? (
        <>
          <dl>
            <dt>Status</dt>
            <dd>{value.job.state}</dd>
            <dt>Phase</dt>
            <dd>{value.job.phase}</dd>
            <dt>Completed rollout groups</dt>
            <dd>
              {value.job.rolloutProgress.groupsCompleted} / {value.job.rolloutProgress.groupsTarget}
            </dd>
            <dt>Applied optimizer updates</dt>
            <dd>{value.job.rolloutProgress.optimizerUpdatesApplied}</dd>
            <dt>Accrued spend</dt>
            <dd>${value.job.accruedSpendUsd.toFixed(6)}</dd>
          </dl>
          {value.job.terminalReason ? <p>{value.job.terminalReason}</p> : null}
          <section>
            <h3>Evals</h3>
            {!value.evals ? (
              <p>No evaluations attached.</p>
            ) : (
              <>
                <p>
                  {postTrainingActive(value.evals) ? (
                    <span className="hosted-training-spinner" aria-hidden="true" />
                  ) : null}
                  {value.evals.state} / {value.evals.completed} / {value.evals.total} completed
                  {value.evals.failed ? ` / ${value.evals.failed} failed` : ""}
                </p>
                {value.evals.reason ? <p>{value.evals.reason}</p> : null}
                <p>Required checks: {value.evals.requiredOutcome}</p>
                {value.evals.candidate ? (
                  <p>
                    Candidate {value.evals.candidate.id}
                    <br />
                    <code>{value.evals.candidate.contentHash}</code>
                  </p>
                ) : null}
                <div>
                  {value.evals.state === "ready" ? (
                    <button type="button" disabled={busy} onClick={() => void control("start")}>
                      Run evals
                    </button>
                  ) : null}
                  {["blocked", "failed", "budget_exhausted"].includes(value.evals.state) ? (
                    <button type="button" disabled={busy} onClick={() => void control("retry")}>
                      Retry evals
                    </button>
                  ) : null}
                  {postTrainingActive(value.evals) ? (
                    <button type="button" disabled={busy} onClick={() => void control("cancel")}>
                      Cancel evals
                    </button>
                  ) : null}
                </div>
                <ul>
                  {value.evals.experimentIds.map((id) => (
                    <li key={id}>
                      <button onClick={() => onOpenExperiment(id)}>{id}</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section>
            <h3>Retained events</h3>
            <ol>
              {value.events.map((event) => (
                <li key={event.id}>
                  {event.phase}
                  {event.message ? ` / ${event.message}` : ""}
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h3>Outputs</h3>
            {value.outputs.outputs.length ? (
              <ul>
                {value.outputs.outputs.map((output) => (
                  <li key={output.id}>{output.id}</li>
                ))}
              </ul>
            ) : (
              <p>No retained outputs yet.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
