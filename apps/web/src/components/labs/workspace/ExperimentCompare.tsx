import type { ConnectedRecordedExecution } from "openpond-sdk/connected-evidence";
import { experimentCaseKey } from "@openpond/evals/experiments";
import { useState } from "react";
import { EvaluationCard, EvaluationTime, evaluationRelativeTime } from "./EvaluationPresentation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ExperimentScoringPass, OpenPondExperimentsClient } from "openpond-sdk/experiments";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { Inventory, WorkspaceApi } from "./workspace-api";
type Comparison = Awaited<ReturnType<OpenPondExperimentsClient["compare"]>>;
import { ExperimentComparisonTables } from "./ExperimentComparisonTables";
import { useRecordedExperimentHistory } from "./RecordedExperimentCollection";
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
  const [candidateKind,setCandidateKind]=useState<"model"|"recorded_evidence">("model");
  const recordedHistory=useRecordedExperimentHistory(api);
  const recordedItems=[...new Map((recordedHistory.data?.pages.flatMap(page=>page.items)??[]).map(item=>[item.id,item])).values()];
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
    queryKey: ["evaluation-workspace", api.key, "comparePasses", candidateExecution,candidateKind],
    enabled: Boolean(candidateExecution),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: { items: ExperimentScoringPass[]; nextCursor: string | null }) =>
      page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }) =>
      api.request<{ items: ExperimentScoringPass[]; nextCursor: string | null }>(
        "passes",
        { id: candidateExecution, ...(candidateKind==="recorded_evidence"?{executionKind:candidateKind}:{}), ...(pageParam ? { afterId: pageParam } : {}) },
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
  const candidateId = candidatePass || (candidateKind==="model"?candidateExecution:"");
  const comparison = useQuery({
    queryKey: ["evaluation-workspace", api.key, "comparison", baselineId, candidateId],
    enabled: false,
    queryFn: async ({ signal }) => {
      const evidence = await api.request<Comparison>("compare", { baselineId, candidateId }, signal);
      const reviewSources = await Promise.all([evidence.baseline, evidence.candidate].map(async result => {
        const id = result.manifest.lineage?.execution.id;
        if (!id) throw new Error("This retained result does not name its original execution.");
        const passId=result.manifest.lineage?.scoringPassId;
        const pass=passId?await api.request<ExperimentScoringPass>("pass",{id:passId},signal):null;
        if(pass?.request.executionKind==="recorded_evidence") {
          const source=await api.request<ConnectedRecordedExecution>("recordedExecution",{id},signal);
          if(source.manifest.contentHash!==pass.request.execution.contentHash)throw new Error("Recorded comparison source differs from its scoring pass.");
          return {id,projectId:source.request.projectId,dataset:source.request.dataset,
            population:source.manifest.population.map((identity,index)=>({...identity,receiptId:source.sources[index]!.boundaryId}))};
        }
        const source=await api.request<ExperimentRunDetails>("experiment",{id},signal);
        return {id,projectId:source.request.project?.id,dataset:source.request.taskset,
          population:source.request.population.map(member=>({caseId:member.taskId,seed:member.seed,fixtureId:member.fixtureId,receiptId:member.receiptId}))};
      }));
      return { ...evidence, reviewSources };
    },
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
        <label>Candidate source<select value={candidateKind} onChange={event=>{setCandidateKind(event.target.value as typeof candidateKind);setCandidateExecution("");setCandidatePass("");}}><option value="model">Target execution</option><option value="recorded_evidence">Recorded evidence</option></select></label>
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
            {candidateKind==="recorded_evidence"?recordedItems.map(item=><option key={item.id} value={item.id}>{item.name} / {item.caseCount} frozen cases</option>):executionItems.map((run) => (
              <option
                key={run.summary.id}
                value={run.summary.id}
                disabled={!run.summary.resultAvailable}
              >
                {evaluationRelativeTime(run.summary.createdAt)} / {run.summary.status} /{" "}
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
              <option value="">{candidateKind==="recorded_evidence"?"Choose a completed scoring pass":"Original grading"}</option>
              {passItems.map((pass) => (
                <option value={pass.id} key={pass.id} disabled={!pass.resultAvailable}>
                  {pass.id} / {pass.status}
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
      {candidateKind==="recorded_evidence"&&recordedHistory.hasNextPage?<button disabled={recordedHistory.isFetchingNextPage} onClick={()=>void recordedHistory.fetchNextPage()}>More recorded Experiments</button>:null}
      {recordedHistory.error&&candidateKind==="recorded_evidence"?<p role="alert">{recordedHistory.error.message}</p>:null}
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
        human={api.humanContext && comparison.data?.reviewSources[0]?.projectId &&
          comparison.data.reviewSources.every(source => source.projectId === comparison.data!.reviewSources[0]!.projectId && source.dataset.contentHash === comparison.data!.reviewSources[0]!.dataset.contentHash)
          ? { context: api.humanContext, projectId: comparison.data.reviewSources[0].projectId,
              dataset: comparison.data.reviewSources[0].dataset,
              selections: identity => comparison.data!.reviewSources.flatMap(source => {
                const member = source.population.find(item => experimentCaseKey(item) === experimentCaseKey(identity));
                return member ? [{executionId:source.id,receiptId:member.receiptId}] : [];
              }) }
          : undefined}
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
