import { useEffect, useMemo, useState } from "react";
import type {
  ModelRun,
  TrainingRunDetail,
  TrainingStateResponse,
} from "@openpond/contracts";

import { api, type ClientConnection } from "../../api";
import { statusLabel } from "../training/training-model-data";
import { LabStatusBadge } from "./LabStatusBadge";

type SeriesEntry = {
  pass: number;
  run: ModelRun;
  jobId: string | null;
  rank: number | null;
  trainTasks: number;
  evaluationTasks: number;
  parent: string;
};

export function LabContinualLearningSeries({
  connection,
  onOpenRun,
  runs,
  state,
}: {
  connection: ClientConnection | null;
  onOpenRun: (runId: string) => void;
  runs: ModelRun[];
  state: TrainingStateResponse | null;
}) {
  const entries = useMemo(() => continualSeries(runs, state), [runs, state]);
  const [details, setDetails] = useState<Map<string, TrainingRunDetail>>(new Map());

  useEffect(() => {
    let disposed = false;
    const jobIds = entries.flatMap((entry) => entry.jobId ? [entry.jobId] : []);
    if (!connection || !jobIds.length) {
      setDetails(new Map());
      return () => { disposed = true; };
    }
    void Promise.all(jobIds.map(async (jobId) => {
      try {
        return [jobId, await api.trainingRunDetail(connection, jobId)] as const;
      } catch {
        return null;
      }
    })).then((results) => {
      if (!disposed) setDetails(new Map(results.flatMap((result) => result ? [result] : [])));
    });
    return () => { disposed = true; };
  }, [connection, entries]);

  if (entries.length < 2) return null;
  return (
    <section className="training-detail-section labs-continual-series">
      <div className="labs-project-trends-heading">
        <div>
          <h2>Continual learning series</h2>
          <p>Each pass trains only on its disclosed cohort; evaluations retain the frozen panel.</p>
        </div>
        <span>{entries.length} checkpoints</span>
      </div>
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr>
              <th>Pass</th>
              <th>Rank</th>
              <th>Parent</th>
              <th>New tasks</th>
              <th>Frozen eval</th>
              <th>Status</th>
              <th>Updates</th>
              <th>Base</th>
              <th>Candidate</th>
              <th>Delta</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const detail = entry.jobId ? details.get(entry.jobId) ?? null : null;
              const scores = evaluationScores(detail);
              const committed = detail?.managedEvidence?.progress.committedOptimizerSteps;
              return (
                <tr key={entry.run.id}>
                  <td>
                    <button
                      className="labs-version-row-button"
                      type="button"
                      onClick={() => onOpenRun(entry.run.id)}
                    >
                      <strong>P{entry.pass}</strong>
                      <small>{entry.run.taskset.id}</small>
                    </button>
                  </td>
                  <td>{entry.rank ?? "—"}</td>
                  <td>{entry.parent}</td>
                  <td>{entry.trainTasks}</td>
                  <td>{entry.evaluationTasks}</td>
                  <td><LabStatusBadge label={statusLabel(entry.run.status)} value={entry.run.status} /></td>
                  <td>{committed ?? "—"}</td>
                  <td>{formatScore(scores.base)}</td>
                  <td>{formatScore(scores.candidate)}</td>
                  <td>{formatDelta(scores.base, scores.candidate)}</td>
                  <td>{formatCost(detail?.managedEvidence?.cost.totalUsd ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function continualSeries(
  runs: ModelRun[],
  state: TrainingStateResponse | null,
): SeriesEntry[] {
  if (!state) return [];
  const tasksets = new Map(
    [...state.tasksets, ...state.modelTasksets].map((taskset) => [taskset.id, taskset] as const),
  );
  const trainingRuns = runs.filter((run) => run.kind === "training");
  const numbered = trainingRuns.flatMap((run) => {
    const taskset = tasksets.get(run.taskset.id);
    const pass = passNumber(taskset?.name ?? "", run.taskset.id);
    return pass === null || pass === 0 ? [] : [{ pass, run }];
  });
  if (!numbered.length) return [];
  const seedCandidates = trainingRuns
    .filter((run) => passNumber(tasksets.get(run.taskset.id)?.name ?? "", run.taskset.id) === null)
    .sort(preferSuccessfulThenRecent);
  const selected = new Map<number, ModelRun>();
  if (seedCandidates[0]) selected.set(0, seedCandidates[0]);
  for (const candidate of numbered.sort((left, right) => preferRecent(left.run, right.run))) {
    if (!selected.has(candidate.pass)) selected.set(candidate.pass, candidate.run);
  }
  const jobsByRun = new Map(state.jobs.flatMap((job) => {
    const modelRunId = typeof job.metadata.modelRunId === "string" ? job.metadata.modelRunId : null;
    return modelRunId ? [[modelRunId, job] as const] : [];
  }));
  const plans = new Map(state.plans.map((plan) => [plan.id, plan] as const));
  const passByJob = new Map<string, number>();
  for (const [pass, run] of selected) {
    const job = jobsByRun.get(run.id);
    if (job) passByJob.set(job.id, pass);
  }
  return [...selected]
    .sort(([left], [right]) => left - right)
    .map(([pass, run]) => {
      const job = jobsByRun.get(run.id) ?? null;
      const plan = job ? plans.get(job.planId) ?? null : null;
      const taskset = tasksets.get(run.taskset.id);
      const continuation = plan?.recipe && "continuation" in plan.recipe
        ? plan.recipe.continuation
        : null;
      const parentPass = continuation
        ? passByJob.get(continuation.sourceArtifact.jobId)
        : undefined;
      return {
        pass,
        run,
        jobId: job?.id ?? null,
        rank: plan?.recipe && "lora" in plan.recipe ? plan.recipe.lora.rank : null,
        trainTasks: taskset?.tasks.filter((task) => task.split === "train").length ?? 0,
        evaluationTasks: taskset?.tasks.filter((task) => task.split === "frozen_eval").length ?? 0,
        parent: continuation ? (parentPass === undefined ? "Accepted artifact" : `P${parentPass}`) : "Base",
      };
    });
}

function passNumber(name: string, id: string): number | null {
  const match = name.match(/(?:^|[\s—_-])P(\d+)\b/i) ?? id.match(/(?:^|[-_])p(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function preferSuccessfulThenRecent(left: ModelRun, right: ModelRun): number {
  if (left.status === "succeeded" && right.status !== "succeeded") return -1;
  if (right.status === "succeeded" && left.status !== "succeeded") return 1;
  return preferRecent(left, right);
}

function preferRecent(left: ModelRun, right: ModelRun): number {
  return right.startedAt.localeCompare(left.startedAt);
}

function evaluationScores(detail: TrainingRunDetail | null): {
  base: number | null;
  candidate: number | null;
} {
  if (detail?.evaluation) {
    return {
      base: detail.evaluation.base.meanScore,
      candidate: detail.evaluation.trained.meanScore,
    };
  }
  const evaluations = detail?.managedEvidence?.evaluations ?? [];
  return {
    base: evaluations.find((item) => item.kind === "baseline")?.score ?? null,
    candidate: evaluations.find((item) => item.kind === "candidate")?.score ?? null,
  };
}

function formatScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function formatDelta(base: number | null, candidate: number | null): string {
  if (base === null || candidate === null) return "—";
  const delta = candidate - base;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;
}

function formatCost(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(3)}`;
}
