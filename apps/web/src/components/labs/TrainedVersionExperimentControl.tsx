import { useEffect, useState, useMemo, useRef } from "react";
import "./hosted-training-run.css";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import {
  createCandidateEvaluationClient,
  type CandidateEvaluationPreparation,
  type CandidateEvaluationOption,
} from "openpond-sdk/candidate-evaluations";
import type { RunExperiment } from "openpond-sdk/experiments";

export function TrainedVersionExperimentControl({
  connection,
  teamId,
  actorId,
  projectId,
  configuration,
  retainOperation,
  onStarted,
  onBusyChange,
}: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  projectId: string | null;
  configuration: RunExperiment | null;
  retainOperation: (
    action: string,
    intent: unknown,
  ) => Promise<{ id: string; acknowledge: () => Promise<void> }>;
  onBusyChange?: (busy: boolean) => void;
  onStarted: (experimentId: string) => void;
}) {
  const scope = JSON.stringify([
    connection.serverUrl,
    connection.token,
    teamId,
    actorId,
    projectId,
  ]);
  const client = useMemo(
    () =>
      createCandidateEvaluationClient(async (path, init) => {
        const parsed = new URL(path, "https://candidate.invalid");
        parsed.searchParams.set("teamId", teamId);
        return apiFetch(connection, `${parsed.pathname}?${parsed.searchParams}`, init);
      }),
    [connection.serverUrl, connection.token, teamId],
  );
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = "unmounted";
    };
  }, [scope]);
  const pending = useRef<{
    scope: string;
    id: string;
    action: "prepare" | "run" | "cancel";
    control: { operationId: string; expectedRevision: number; requestHash: string };
    acknowledge: () => Promise<void>;
  } | null>(null);
  const [catalog, setCatalog] = useState<{
      scope: string;
      items: CandidateEvaluationOption[];
    } | null>(null),
    [selected, setSelected] = useState(""),
    [retained, setRetained] = useState<{
      scope: string;
      value: CandidateEvaluationPreparation;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const value = retained?.scope === scope ? retained.value : null;
  useEffect(() => {
    let stopped = false;
    setError(null);
    setBusy(false);
    setSelected("");
    if (pending.current?.scope !== scope) pending.current = null;
    if (!actorId) return;
    async function read() {
      try {
        const items: CandidateEvaluationOption[] = [];
        let afterId: string | undefined;
        const seen = new Set<string>();
        for (let n = 0; ; n++) {
          if (n >= 100) throw new Error("Candidate catalog exceeds its bounded supported scope.");
          const page = await client.options(teamId, { projectId: projectId ?? undefined, afterId });
          if (page.ownerUserId !== actorId) throw new Error("The candidate owner changed.");
          items.push(...page.items);
          if (!page.nextCursor) break;
          if (seen.has(page.nextCursor)) throw new Error("Candidate pagination did not advance.");
          seen.add(page.nextCursor);
          afterId = page.nextCursor;
        }
        if (!stopped) setCatalog({ scope, items });
      } catch (reason) {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Candidate catalog is unavailable.");
      }
    }
    void read();
    return () => {
      stopped = true;
    };
  }, [client, teamId, actorId, projectId, scope]);
  useEffect(() => {
    if (!value || !["preparing", "dispatching", "submitted", "cleaning"].includes(value.state))
      return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await client.get(teamId, value.id);
        if (!stopped) {
          if (next.ownerUserId !== actorId) throw new Error("The candidate owner changed.");
          setRetained({ scope, value: next });
        }
      } catch (reason) {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Candidate status is unavailable.");
      }
      if (!stopped) timer = setTimeout(read, 3000);
    };
    timer = setTimeout(read, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, teamId, scope, value?.id, value?.state]);
  async function perform(action: "prepare" | "run" | "cancel") {
    if (busy || !actorId) return;
    const callScope = scope;
    const fence = () => {
      if (activeScope.current !== callScope)
        throw new Error(
          "The active account or Project changed. Reopen candidate evaluation setup.",
        );
    };
    setBusy(true);
    setError(null);
    try {
      let current = value;
      if (!current) {
        const target =
          catalog?.scope === scope ? catalog.items.find((c) => c.artifact.id === selected) : null;
        if (!target || !configuration)
          throw new Error(
            "Choose a trained version and complete the exact evaluation cases, graders and budget.",
          );
        const operation = await retainOperation("candidate:save", {
          teamId,
          actorId,
          projectId,
          artifact: target.artifact,
          configuration,
        });
        fence();
        current = await client.save({
          teamId,
          operationId: operation.id,
          artifact: target.artifact,
          configuration,
        });
        fence();
        if (current.ownerUserId !== actorId) throw new Error("The candidate owner changed.");
        setRetained({ scope, value: current });
        await operation.acknowledge();
        fence();
      }
      let command = pending.current?.scope === scope ? pending.current : null;
      if (command && command.action !== action)
        throw new Error("Resolve the retained uncertain action before choosing another action.");
      if (!command) {
        const intent = {
          teamId,
          actorId,
          projectId,
          id: current.id,
          action,
          expectedRevision: current.revision,
          requestHash: current.requestHash,
        };
        const operation = await retainOperation("candidate:control", intent);
        fence();
        command = {
          scope,
          id: current.id,
          action,
          control: {
            operationId: operation.id,
            expectedRevision: current.revision,
            requestHash: current.requestHash,
          },
          acknowledge: operation.acknowledge,
        };
        pending.current = command;
      }
      const next = await client.control(teamId, command.id, command.action, command.control);
      fence();
      if (next.ownerUserId !== actorId) throw new Error("The candidate owner changed.");
      setRetained({ scope, value: next });
      await command.acknowledge();
      fence();
      pending.current = null;
      if (next.experimentId) onStarted(next.experimentId);
    } catch (reason) {
      if (activeScope.current === callScope)
        setError(
          reason instanceof Error ? reason.message : "Candidate evaluation could not proceed.",
        );
    } finally {
      if (activeScope.current === callScope) setBusy(false);
    }
  }
  return (
    <section>
      <label>
        Trained version
        <select
          disabled={busy || !!value}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Select owned trained artifact</option>
          {catalog?.scope === scope
            ? catalog.items.map((item) => (
                <option key={item.artifact.id} value={item.artifact.id}>
                  {item.artifact.id} / {item.artifact.contentHash.slice(0, 12)}
                  {item.reason ? ` / ${item.reason}` : ""}
                </option>
              ))
            : null}
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      {value ? (
        <>
          <p role="status">
            {["preparing", "dispatching", "submitted", "cleaning"].includes(value.state) ? (
              <span className="hosted-training-spinner" aria-hidden="true" />
            ) : null}
            {value.state}
            {value.reason ? ` / ${value.reason}` : ""}
          </p>
          <details>
            <summary>Frozen evaluation setup</summary>
            <pre>{JSON.stringify(value.request.configuration, null, 2)}</pre>
          </details>
          {configuration &&
          JSON.stringify(configuration) !== JSON.stringify(value.request.configuration) ? (
            <p>The parent setup changed. This preparation retains the reviewed setup shown here.</p>
          ) : null}
        </>
      ) : null}
      <div>
        {pending.current?.scope === scope ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void perform(pending.current!.action)}
          >
            Retry retained {pending.current.action} action
          </button>
        ) : null}
        {!value || ["configured", "preparing"].includes(value.state) ? (
          <button
            type="button"
            disabled={busy || !configuration || !selected}
            onClick={() => void perform("prepare")}
          >
            Prepare exact version for evaluation
          </button>
        ) : null}
        {value && ["ready", "dispatching"].includes(value.state) ? (
          <button type="button" disabled={busy} onClick={() => void perform("run")}>
            Run Experiment
          </button>
        ) : null}
        {value && !["completed", "failed", "cancelled"].includes(value.state) ? (
          <button type="button" disabled={busy} onClick={() => void perform("cancel")}>
            Cancel evaluation
          </button>
        ) : null}
      </div>
    </section>
  );
}
