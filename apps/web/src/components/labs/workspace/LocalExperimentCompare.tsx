import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { compareExperiments } from "@openpond/evals/experiments";
import {
  LocalExperimentComparisonSchema, LocalExperimentResultSchema,
  LocalExperimentRecordPageSchema,
  type LocalExperimentRecord,
} from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import { EvaluationCard, EvaluationTime, evaluationRelativeTime } from "./EvaluationPresentation";
import { ExperimentComparisonTables } from "./ExperimentComparisonTables";
import type { ExperimentGraderPin } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "./workspace-api";

export function LocalExperimentCompare({
  api,
  baselineId,
  graders = [],
  onOpenGrader,
}: {
  api: WorkspaceApi;
  baselineId: string | null;
  executions?: LocalExperimentRecord[];
  graders?: ExperimentGraderPin[];
  onOpenGrader?: (release: NonNullable<ExperimentGraderPin["release"]>) => void;
}) {
  const collection = useInfiniteQuery({
    queryKey: ["local-experiments", api.key, "compareCandidates"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      localRequest(
        api,
        LocalExperimentRecordPageSchema,
        "list",
        {
          ...(api.projectId ? { projectId: api.projectId } : {}),
          ...(pageParam ? { afterId: pageParam } : {}),
        },
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const executions = collection.data?.pages.flatMap((page) => page.items) ?? [];
  const [candidateId, setCandidateId] = useState("");
  const [feedbackKey, setFeedbackKey] = useState("");
  const comparison = useQuery({
    queryKey: ["local-experiments", api.key, "compare", baselineId, candidateId],
    enabled: Boolean(baselineId && candidateId),
    queryFn: async ({ signal }) => {
      const evidence = await localRequest(
        api,
        LocalExperimentComparisonSchema,
        "compare",
        { baselineId, candidateId },
        signal,
      );
      return {evidence,comparison:compareExperiments(evidence.baseline, evidence.candidate)};
    },
  });
  const candidate = executions.find((item) => item.id === candidateId);
  const retained=comparison.data?.evidence,data=comparison.data?.comparison;
  const sourceIds=retained?[retained.baseline.execution.sourceExecution?.id??retained.baseline.execution.id,retained.candidate.execution.sourceExecution?.id??retained.candidate.execution.id]:null;
  const members=useQuery({queryKey:["local-experiments",api.key,"human-comparison-members",sourceIds],enabled:Boolean(sourceIds&&api.humanContext),queryFn:({signal})=>Promise.all(sourceIds!.map(id=>localRequest(api,LocalExperimentResultSchema,"result",{id},signal)))});
  const human=api.humanContext&&api.projectId&&retained&&members.data?{context:api.humanContext,projectId:api.projectId,dataset:retained.baseline.manifest.dataset,selections:(identity:NonNullable<typeof data>["cases"][number]["identity"])=>members.data!.flatMap((result,index)=>{const member=result.cases.find(row=>row.taskId===identity.caseId&&row.seed===identity.seed);return member?[{executionId:sourceIds![index]!,receiptId:member.receiptId}]:[];})}:undefined;


  return (
    <EvaluationCard title="Compare retained local results">
      <label>
        Candidate Experiment
        <select
          value={candidateId}
          onChange={(event) => {
            setCandidateId(event.target.value);
            setFeedbackKey("");
          }}
        >
          <option value="">Choose retained Experiment</option>
          {executions
            .filter((item) => item.id !== baselineId && item.completedAt && item.cleanupComplete)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {evaluationRelativeTime(item.createdAt)}, {item.status}, {item.id}
              </option>
            ))}
        </select>
      </label>
      {collection.hasNextPage ? (
        <button
          disabled={collection.isFetchingNextPage}
          onClick={() => void collection.fetchNextPage()}
        >
          More experiments
        </button>
      ) : null}
      {collection.error ? <p role="alert">{collection.error.message}</p> : null}
      {candidate ? (
        <p>
          Started <EvaluationTime value={candidate.createdAt} />
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
                <li key={reason}>{reason.replaceAll("_", " ")}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <ExperimentComparisonTables
        human={human}
        data={data}
        loading={comparison.isFetching}
        error={comparison.error?.message}
        retry={() => void comparison.refetch()}
        graders={candidate?.graders ?? graders}
        onOpenGrader={onOpenGrader}
        feedbackKey={feedbackKey}
        onFeedbackKey={setFeedbackKey}
      />
    </EvaluationCard>
  );
}
