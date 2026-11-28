import { ErrorToast } from "../common/ErrorToast";
import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import "./hosted-training-run.css";
import type { ClientConnection } from "../../api/api-client";
import {
  type CandidateEvaluationPreparation,
  type CandidateEvaluationOption,
} from "openpond-sdk/candidate-evaluations";
import type { RunExperiment } from "openpond-sdk/experiments";
import { canonicalJson, type TrainingModelVersion } from "openpond-sdk/training";
import { desktopCandidateEvaluationClient, readCandidateTrainingResult } from "./desktop-candidate-evaluation";
import { connectionQueryScope } from "../../lib/query-scope";

export function TrainedVersionExperimentControl({
  connection,
  teamId,
  actorId,
  projectId,
  configuration,
  version,
  benchmarkId,
  benchmarkRevision,
  bindBenchmark,
  recoverBenchmark,
  retainOperation,
  onStarted,
  onBusyChange,
}: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  projectId: string | null;
  configuration: RunExperiment | null;
  version?: TrainingModelVersion;
  benchmarkId?: string;
  benchmarkRevision?: number;
  bindBenchmark?: (preparationId: string, revision: number, versionHash: string) => Promise<void>;
  recoverBenchmark?: (revision: number, versionHash: string) => Promise<string | null>;
  retainOperation: (
    action: string,
    intent: unknown,
  ) => Promise<{ id: string; acknowledge: () => Promise<void> }>;
  onBusyChange?: (busy: boolean) => void;
  onStarted: (experimentId: string) => void;
}) {
  const scope = JSON.stringify([
    connectionQueryScope(connection),
    teamId,
    actorId,
    projectId,
    version?.contentHash ?? null,
    benchmarkId ?? null,
    benchmarkRevision ?? null,
  ]);
  const client = useMemo(() => desktopCandidateEvaluationClient(connection), [connection]);
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
  const retainedRevision = useRef<{ scope: string; revision: number } | null>(null);
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
  const recovery = useQuery({
    queryKey: ["saved-benchmark-preparation", scope],
    enabled: Boolean(recoverBenchmark && version && benchmarkRevision),
    queryFn: async () => {
      const id = await recoverBenchmark!(benchmarkRevision!, version!.contentHash);
      if (!id) return null;
      const value = await client.get(teamId, id);
      if (value.ownerUserId !== actorId || value.trainingJobId !== version?.jobId)
        throw new Error("The recovered preparation belongs to a different saved Model version.");
      return value;
    },
    retry: false,
    refetchOnMount: "always",
  });
  const value = retained?.scope === scope ? retained.value : recovery.data ?? null;
  const recoveryPending = recovery.fetchStatus === "fetching" && !value;
  const finished = Boolean(value && ["completed", "failed", "cancelled"].includes(value.state));
  async function bind(value: CandidateEvaluationPreparation) {
    if (!version) return;
    const retained = retainedRevision.current;
    const revision = retained?.scope === scope ? retained.revision : benchmarkRevision;
    if (!bindBenchmark || !revision)
      throw new Error("Review and save the exact Benchmark before preparing this version.");
    await bindBenchmark(value.id, revision, version.contentHash);
  }
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
        let exactArtifactId: string | undefined;
        if (version) {
          const result = await readCandidateTrainingResult(connection, teamId, version.jobId);
          const candidate = result.candidate;
          if (version.teamId !== teamId || result.job.modelProjectId !== version.modelProjectId ||
            !candidate?.registryArtifactId || candidate.checkpointId !== version.candidate.checkpointId ||
            canonicalJson(candidate.artifact) !== canonicalJson(version.candidate.artifact))
            throw new Error("The exact saved Model version has no owned candidate artifact available for evaluation.");
          exactArtifactId = candidate.registryArtifactId;
        }
        let afterId: string | undefined;
        const seen = new Set<string>();
        for (let n = 0; ; n++) {
          if (n >= 100) throw new Error("Candidate catalog exceeds its bounded supported scope.");
          const page = await client.options(teamId, { projectId: projectId ?? undefined, afterId });
          if (page.ownerUserId !== actorId) throw new Error("The candidate owner changed.");
          items.push(...(version ? page.items.filter(item => item.artifact.id === exactArtifactId &&
            item.trainingJobId === version.jobId && item.configurationId === version.modelProjectId) : page.items));
          if (version && items.length) break;
          if (!page.nextCursor) break;
          if (seen.has(page.nextCursor)) throw new Error("Candidate pagination did not advance.");
          seen.add(page.nextCursor);
          afterId = page.nextCursor;
        }
        if (version && !items.length) throw new Error("This Model version is unavailable in the current candidate catalog.");
        if (!stopped) {
          setCatalog({ scope, items });
          if (version) setSelected(items[0]!.artifact.id);
        }
      } catch (reason) {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Candidate catalog is unavailable.");
      }
    }
    void read();
    return () => {
      stopped = true;
    };
  }, [client, connection, teamId, actorId, projectId, scope, version]);
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
  async function perform(action: "prepare" | "run" | "cancel", another = false) {
    if (busy || !actorId || recoveryPending || recovery.isError && !value || another && (!finished || pending.current)) return;
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
      let current = another ? null : value;
      if (!current) {
        const target =
          catalog?.scope === scope ? catalog.items.find((c) => c.artifact.id === selected) : null;
        if (!target || !configuration)
          throw new Error(
            "Choose a trained version and complete the exact evaluation cases, graders and budget.",
          );
        if (version && (!benchmarkRevision || !bindBenchmark))
          throw new Error("Review and save the exact Benchmark before preparing this version.");
        const operation = await retainOperation("candidate:save", {
          teamId,
          actorId,
          projectId,
          artifact: target.artifact,
          configuration,
          ...(benchmarkRevision ? { benchmarkRevision } : {}),
          ...(another && value ? { previousPreparationId: value.id } : {}),
        });
        fence();
        const request = {
          teamId,
          operationId: operation.id,
          artifact: target.artifact,
          configuration,
        };
        current = await client.save(request);
        fence();
        if (current.ownerUserId !== actorId || canonicalJson(current.request) !== canonicalJson(request) ||
          version && current.trainingJobId !== version.jobId)
          throw new Error("The retained evaluation differs from the reviewed candidate or workspace.");
        setRetained({ scope, value: current });
        if (benchmarkRevision) retainedRevision.current = { scope, revision: benchmarkRevision };
        await bind(current);
        fence();
        await operation.acknowledge();
        fence();
      } else {
        await bind(current);
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
      if (next.experimentId) {
        await bind(next);
        fence();
        onStarted(next.experimentId);
      }
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
      {version ? <dl className="training-context-facts">
        <dt>Exact version</dt><dd>{version.contentHash}</dd>
        <dt>Training artifact</dt><dd>{version.candidate.artifact.contentHash}</dd>
      </dl> : <label>
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
      </label>}
      <ErrorToast error={error ?? recovery.error}>
        {recovery.isError ? <button type="button" className="training-text-button" onClick={() => void recovery.refetch()}>Retry saved preparation</button> : null}
      </ErrorToast>
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
            disabled={busy || recoveryPending || !value && (recovery.isError || !configuration || !selected) || Boolean(version && !benchmarkRevision)}
            onClick={() => void perform("prepare")}
          >
            Prepare exact version for evaluation
          </button>
        ) : null}
        {version && finished && configuration && !pending.current && (
          <button type="button" disabled={busy || !selected || !benchmarkRevision} onClick={() => void perform("prepare", true)}>
            Prepare another run
          </button>
        )}
        {value && ["ready", "dispatching"].includes(value.state) ? (
          <button type="button" disabled={busy} onClick={() => void perform("run")}>
            {version ? "Run Benchmark" : "Run Experiment"}
          </button>
        ) : null}
        {version && value?.experimentId ? (
          <button type="button" disabled={busy} onClick={() => {
            setBusy(true);
            void bind(value).then(() => {
              if (activeScope.current === scope) onStarted(value.experimentId!);
            }).catch(cause => {
              if (activeScope.current === scope) setError(cause instanceof Error ? cause.message : "Benchmark unavailable.");
            }).finally(() => { if (activeScope.current === scope) setBusy(false); });
          }}>Open Benchmark run</button>
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
