import { useState } from "react";
import { EvaluationCard, EvaluationTime, evaluationRelativeTime } from "./EvaluationPresentation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ExperimentScoringPass, OpenPondExperimentsClient } from "openpond-sdk/experiments";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { Inventory, WorkspaceApi } from "./workspace-api";
type Comparison = Awaited<ReturnType<OpenPondExperimentsClient["compare"]>>;
import { ExperimentComparisonTables } from "./ExperimentComparisonTables";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
export function ExperimentCompare({
  api,
  baselineId,
  graders = [],
  onOpenGrader,
}: {
  api: WorkspaceApi;
  inventory?: Inventory | null;
  definitionId?: string;
  baselineId: string | null;
  graders?: ExperimentGraderPin[];
  onOpenGrader?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
}) {
  const [candidateExecution, setCandidateExecution] = useState("");
  const [candidatePass, setCandidatePass] = useState("");
  const history = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "compareCandidates"],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: { items: ExperimentRunDetails[]; nextCursor: string | null }) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) =>
      api.request<{ items: ExperimentRunDetails[]; nextCursor: string | null }>(
        "experiments",
        { ...(pageParam ? { afterId: pageParam } : {}), limit: 30 },
        signal,
      ),
  });
  const passes = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "comparePasses", candidateExecution],
    enabled: Boolean(candidateExecution),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: { items: ExperimentScoringPass[]; nextCursor: string | null }) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) =>
      api.request<{ items: ExperimentScoringPass[]; nextCursor: string | null }>(
        "passes",
        { id: candidateExecution, ...(pageParam ? { afterId: pageParam } : {}) },
        signal,
      ),
  });
  const executionItems = [
    ...new Map(
      (history.data?.pages.flatMap((page) => page.items) ?? []).map((run) => [run.summary.id, run]),
    ).values(),
  ];
  const passItems = [
    ...new Map(
      (passes.data?.pages.flatMap((page) => page.items) ?? []).map((pass) => [pass.id, pass]),
    ).values(),
  ];
  const selectedCandidate = executionItems.find((run) => run.summary.id === candidateExecution);
  const candidateId = candidatePass || candidateExecution;
  const comparison = useQuery({
    queryKey: ["evaluation-workspace", api.key, "comparison", baselineId, candidateId],
    enabled: false,
    queryFn: ({ signal }) =>
      api.request<Comparison>("compare", { baselineId, candidateId }, signal),
  });
  const [feedbackKey, setFeedbackKey] = useState("");
  const data = comparison.data?.comparison;
  return (
    <EvaluationCard title="Compare retained results">
      <p>
        Baseline: {baselineId ?? "Choose a completed Experiment"}. Compatibility and eligible cases
        use the same comparison rules as the API and CLI.
      </p>
      <div className="evaluation-workspace-scope">
        <label>
          Candidate Experiment
          <select
            value={candidateExecution}
            onChange={(event) => {
              setCandidateExecution(event.target.value);
              setCandidatePass("");
            }}
          >
            <option value="">Choose retained Experiment</option>
            {executionItems.map((run) => (
              <option
                key={run.summary.id}
                value={run.summary.id}
                disabled={!run.summary.resultAvailable}
              >
                {evaluationRelativeTime(run.summary.createdAt)} · {run.summary.status} ·{" "}
                {"modelId" in run.request.policy
                  ? run.request.policy.modelId
                  : run.request.policy.kind}
              </option>
            ))}
          </select>
        </label>
        {selectedCandidate ? (
          <span>
            Started{" "}
            <EvaluationTime
              value={selectedCandidate.summary.startedAt ?? selectedCandidate.summary.createdAt}
            />
          </span>
        ) : null}
        {passItems.length ? (
          <label>
            Candidate scoring
            <select
              value={candidatePass}
              onChange={(event) => setCandidatePass(event.target.value)}
            >
              <option value="">Original grading</option>
              {passItems.map((pass) => (
                <option value={pass.id} key={pass.id} disabled={!pass.resultAvailable}>
                  {pass.id} · {pass.status}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="training-button secondary"
          disabled={!candidateId || !baselineId || comparison.isFetching}
          onClick={() => void comparison.refetch()}
        >
          {comparison.isFetching ? "Reading retained comparison…" : "Compare"}
        </button>
      </div>
      {history.hasNextPage ? (
        <button disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          More experiments
        </button>
      ) : null}
      {passes.hasNextPage ? (
        <button disabled={passes.isFetchingNextPage} onClick={() => void passes.fetchNextPage()}>
          Older scoring passes
        </button>
      ) : null}
      {history.error || passes.error || comparison.error ? (
        <p role="alert">
          {history.error?.message ?? passes.error?.message ?? comparison.error?.message}
        </p>
      ) : null}
      {data ? (
        <>
          <p role="status">
            {data.comparable
              ? "Compatible retained populations"
              : "Comparison unavailable for these results"}
          </p>
          {data.reasons.length ? (
            <ul>
              {data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>This reads stored results without running the target or grader.</p>
      )}
      <ExperimentComparisonTables
        data={data}
        loading={comparison.isFetching}
        error={comparison.error?.message}
        retry={() => void comparison.refetch()}
        graders={
          candidatePass
            ? (passItems.find((pass) => pass.id === candidatePass)?.graders ?? [])
            : (selectedCandidate?.configuration.graders ?? graders)
        }
        onOpenGrader={onOpenGrader}
        feedbackKey={feedbackKey}
        onFeedbackKey={setFeedbackKey}
      />
    </EvaluationCard>
  );
}
