import { contentHash } from "@openpond/harness";
import { HostedTrainingPolicyControlSchema } from "openpond-sdk/post-training";
import { useEffect, useRef, useState } from "react";
import {
  HostedTrainingPolicyDetailSchema,
  type HostedTrainingPolicyControl,
  postTrainingActive,
} from "openpond-sdk/post-training";
import { z } from "zod";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import "./hosted-training-run.css";
type Detail = z.infer<typeof HostedTrainingPolicyDetailSchema>;
export function HostedTrainingPolicyDetail({
  connection,
  teamId,
  actorId,
  policyId,
  retainOperation,
  onOpenJob,
  onOpenExperiment,
}: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  policyId: string;
  retainOperation: (
    action: string,
    intent: unknown,
  ) => Promise<{ id: string; acknowledge: () => Promise<void> }>;
  onOpenJob: (id: string) => void;
  onOpenExperiment: (id: string) => void;
}) {
  const scope = JSON.stringify([connection.serverUrl, connection.token, teamId, actorId, policyId]),
    [afterId, setAfterId] = useState<string | undefined>(),
    [retained, setRetained] = useState<{
      scope: string;
      afterId: string | undefined;
      value: Detail;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = "unmounted";
    };
  }, [scope]);
  const recoveryKey = `openpond:policy-control:${contentHash({ apiOrigin: connection.serverUrl, teamId, actorId, policyId })}`;
  const pending = useRef<HostedTrainingPolicyControl | null>(null),
    value = retained?.scope === scope && retained.afterId === afterId ? retained.value : null;
  useEffect(() => {
    pending.current = null;
    setBusy(false);
    setAfterId(undefined);
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (raw) {
        const body = HostedTrainingPolicyControlSchema.parse(JSON.parse(raw));
        if (body.id !== policyId) throw new Error("Retained control belongs to another policy.");
        pending.current = body;
        setRevision((v) => v + 1);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Retained control could not be recovered.",
      );
    }
  }, [scope, recoveryKey, policyId]);
  const path = `/v1/training/hosted-policies/${encodeURIComponent(policyId)}`;
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    async function read() {
      try {
        const params = new URLSearchParams({ teamId });
        if (afterId) params.set("afterId", afterId);
        const next = HostedTrainingPolicyDetailSchema.parse(
          await apiFetch(connection, `${path}?${params}`),
        );
        if (next.teamId !== teamId || next.actorId !== actorId || next.policy.id !== policyId)
          throw new Error("The policy belongs to a different account or workspace.");
        if (!stopped) {
          setRetained({ scope, afterId, value: next });
          setError(null);
        }
      } catch (reason) {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Learning policy is unavailable.");
      }
      if (!stopped) timer = setTimeout(read, 3000);
    }
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [
    connection.serverUrl,
    connection.token,
    teamId,
    actorId,
    policyId,
    path,
    scope,
    afterId,
    revision,
  ]);
  async function control(
    action: HostedTrainingPolicyControl["action"],
    iterationId?: string,
    iterationRevision?: number,
  ) {
    if (!value || busy) return;
    const callScope = scope;
    const fence = () => {
      if (activeScope.current !== callScope)
        throw new Error("The active account, workspace or policy changed. Reopen this policy.");
    };
    setBusy(true);
    setError(null);
    try {
      const prior = pending.current;
      const intent = prior
        ? {
            id: prior.id,
            expectedRevision: prior.expectedRevision,
            policyHash: prior.policyHash,
            action: prior.action,
            ...(prior.iterationId
              ? { iterationId: prior.iterationId, iterationRevision: prior.iterationRevision }
              : {}),
          }
        : {
            id: policyId,
            expectedRevision: value.policy.revision,
            policyHash: value.policy.contentHash,
            action,
            ...(iterationId ? { iterationId, iterationRevision } : {}),
          };
      const operation = await retainOperation("training:policy-control", {
        teamId,
        actorId,
        ...intent,
      });
      fence();
      const body = pending.current ?? { ...intent, operationId: operation.id };
      localStorage.setItem(recoveryKey, JSON.stringify(body));
      if (localStorage.getItem(recoveryKey) !== JSON.stringify(body))
        throw new Error("Enable durable storage before controlling this policy.");
      pending.current = body;
      await apiFetch(connection, `${path}/control?teamId=${encodeURIComponent(teamId)}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      fence();
      await operation.acknowledge();
      fence();
      localStorage.removeItem(recoveryKey);
      pending.current = null;
      setRevision((v) => v + 1);
    } catch (reason) {
      if (activeScope.current === callScope)
        setError(reason instanceof Error ? reason.message : "Policy control failed.");
    } finally {
      if (activeScope.current === callScope) setBusy(false);
    }
  }
  return (
    <section className="labs-resource-page">
      <h2>Continual learning policy</h2>
      {error ? <p role="alert">{error}</p> : null}
      {!value ? (
        <p role="status">Loading exact policy…</p>
      ) : (
        <>
          <h3>{value.configuration.name}</h3>
          <p>
            {value.policy.enabled ? "Enabled" : "Paused"} /{" "}
            {value.policy.trigger.kind.replaceAll("_", " ")} /{" "}
            {value.policy.admission.mode === "human"
              ? "Human review required"
              : "Qualified automatic admission"}
          </p>
          <code>
            {value.policy.id} / revision {value.policy.revision}
          </code>
          <dl>
            <dt>Eligible approved examples</dt>
            <dd>{value.inspection.counts?.eligible ?? "Unavailable"}</dd>
            <dt>Awaiting review</dt>
            <dd>{value.inspection.counts?.awaitingReview ?? "Unavailable"}</dd>
            <dt>Already consumed</dt>
            <dd>{value.inspection.counts?.consumed ?? "Unavailable"}</dd>
            <dt>Reserved spend</dt>
            <dd>${value.inspection.budget.reservedSpendUsd}</dd>
            <dt>Settled spend</dt>
            <dd>${value.inspection.budget.settledSpendUsd}</dd>
            <dt>Iteration ceiling</dt>
            <dd>${value.policy.limits.maxIterationSpendUsd}</dd>
            <dt>Daily ceiling</dt>
            <dd>${value.policy.limits.maxDailySpendUsd}</dd>
          </dl>
          {value.inspection.blockers.length ? (
            <ul>
              {value.inspection.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
          <p>
            Starting checkpoint: {value.inspection.trainingParent?.reference.id ?? "Unavailable"}
            {value.inspection.trainingParent?.selection
              ? " / latest accepted candidate, optimizer state resets"
              : ""}
          </p>
          {pending.current ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const body = pending.current;
                if (body) void control(body.action, body.iterationId, body.iterationRevision);
              }}
            >
              Retry retained action
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void control(value.policy.enabled ? "pause" : "resume")}
              >
                {value.policy.enabled ? "Pause learning" : "Resume learning"}
              </button>
              <button
                type="button"
                disabled={busy || !value.inspection.canReserve}
                onClick={() => void control("reserve")}
              >
                Train on approved tasks
              </button>
            </>
          )}
          <h3>Iterations and evaluations</h3>
          <table>
            <thead>
              <tr>
                <th>Iteration</th>
                <th>Status</th>
                <th>Training</th>
                <th>Evals</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {value.iterations.map(({ iteration, evals }) => (
                <tr key={iteration.id}>
                  <td>{iteration.id}</td>
                  <td>{iteration.status}</td>
                  <td>
                    {iteration.trainingJob ? (
                      <button type="button" onClick={() => onOpenJob(iteration.trainingJob!.id)}>
                        Open training run
                      </button>
                    ) : (
                      "No admitted training job"
                    )}
                  </td>
                  <td>
                    {evals ? (
                      <>
                        <span>
                          {postTrainingActive(evals) ? (
                            <span className="hosted-training-spinner" aria-hidden="true" />
                          ) : null}
                          {evals.state} / {evals.completed}/{evals.total} completed / required
                          checks: {evals.requiredOutcome}
                        </span>
                        {evals.reason ? <p>{evals.reason}</p> : null}
                        {evals.experimentIds.map((id) => (
                          <button type="button" key={id} onClick={() => onOpenExperiment(id)}>
                            Open {id}
                          </button>
                        ))}
                      </>
                    ) : (
                      "No evaluations attached"
                    )}
                  </td>
                  <td>
                    {["ready", "dispatching", "training", "evaluating", "failed"].includes(
                      iteration.status,
                    ) ? (
                      <button
                        type="button"
                        disabled={busy || !!pending.current}
                        onClick={() =>
                          void control("cancel-iteration", iteration.id, iteration.revision)
                        }
                      >
                        Cancel iteration
                      </button>
                    ) : null}
                    {iteration.status === "failed" ? (
                      <button
                        type="button"
                        disabled={busy || !!pending.current}
                        onClick={() =>
                          void control("retry-iteration", iteration.id, iteration.revision)
                        }
                      >
                        Retry iteration dispatch
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            {afterId ? (
              <button type="button" onClick={() => setAfterId(undefined)}>
                First page
              </button>
            ) : null}
            {value.nextCursor ? (
              <button type="button" onClick={() => setAfterId(value.nextCursor ?? undefined)}>
                Next page
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
