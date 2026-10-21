import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { RunStageEvidenceSchema } from "@openpond/contracts";
import { TrainingJobSchema, TrainingJobEventSchema, TrainingJobOutputsSchema } from "openpond-sdk/training";
import { PostTrainingSummarySchema, postTrainingActive } from "openpond-sdk/post-training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";

const Detail = z.object({
  job: TrainingJobSchema,
  events: z.array(TrainingJobEventSchema).max(10_000),
  outputs: TrainingJobOutputsSchema,
  evals: PostTrainingSummarySchema.nullable(),
  flow: RunStageEvidenceSchema.nullable(),
  flowError: z.string().nullable(),
}).strict();
export type HostedTrainingRunDetail = z.infer<typeof Detail>;
const terminal = new Set(["completed", "succeeded", "failed", "cancelled", "budget_exhausted"]);

/** Core data and native graph are independent: graph latency cannot hide a run.
 * The cache is scoped to the authenticated connection and workspace. */
export function useHostedTrainingRun(connection: ClientConnection, teamId: string, jobId: string, projectId?: string, includeLogs = false) {
  const queries = useQueryClient();
  const scope = connectionQueryScope(connection);
  const key = ["hosted-training-run", scope, teamId, jobId, projectId ?? null] as const;
  const path = `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}`;
  const summary = useQuery({
    queryKey: [...key, "summary"],
    queryFn: async ({ signal }) => {
      const job = TrainingJobSchema.parse(await apiFetch(connection, `${path}/summary?teamId=${encodeURIComponent(teamId)}`, { signal }));
      if (job.id !== jobId || job.teamId !== teamId || projectId && job.modelProjectId !== projectId) throw new Error("Run summary belongs to another workspace.");
      return job;
    },
    staleTime: 30_000, gcTime: 300_000,
    refetchInterval: query => query.state.data && !terminal.has(query.state.data.state) ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const logs = useQuery({
    queryKey: [...key, "logs"],
    queryFn: async ({ signal }) => RunStageEvidenceSchema.shape.logs.parse(await apiFetch(connection, `${path}/logs?teamId=${encodeURIComponent(teamId)}`, { signal })),
    enabled: includeLogs,
    staleTime: 30_000, gcTime: 300_000,
    refetchInterval: includeLogs && summary.data && !terminal.has(summary.data.state) ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const core = useQuery({
    queryKey: [...key, "core"],
    queryFn: async ({ signal }) => {
      const detail = Detail.parse(await apiFetch(connection, `${path}?teamId=${encodeURIComponent(teamId)}&graph=false`, { signal }));
      if (detail.job.id !== jobId || detail.job.teamId !== teamId || projectId && detail.job.modelProjectId !== projectId)
        throw new Error("Run does not belong to this Model Project and workspace.");
      return detail;
    },
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: query => query.state.data && (!terminal.has(query.state.data.job.state) || postTrainingActive(query.state.data.evals)) ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const graph = useQuery({
    queryKey: [...key, "flow"],
    queryFn: async ({ signal }) => {
      const flow = RunStageEvidenceSchema.parse(await apiFetch(connection, `${path}/flow?teamId=${encodeURIComponent(teamId)}`, { signal }));
      if (flow.jobId !== jobId || flow.teamId !== teamId || projectId && flow.modelProjectId !== projectId)
        throw new Error("Run stages do not belong to this Model Project and workspace.");
      return flow;
    },
    staleTime: 30_000,
    gcTime: 300_000,
    refetchInterval: query => query.state.data?.live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
  const flow = graph.data && (!core.data || graph.data.modelProjectId === core.data.job.modelProjectId) ? graph.data : null;
  const latestSummary = summary.data && (!core.data || summary.data.version >= core.data.job.version) ? summary.data : core.data?.job ?? null;
  return {
    detail: core.data ? { ...core.data, flow } : null,
    flow,
    summary: latestSummary,
    logs: logs.data ?? [],
    logsLoading: logs.isPending,
    logsError: logs.error?.message ?? null,
    loading: core.isPending,
    graphLoading: graph.isPending,
    error: (!core.data && !summary.data ? summary.error?.message : null) ?? core.error?.message ?? graph.error?.message ?? null,
    refresh: () => Promise.all([summary.refetch(), core.refetch(), graph.refetch(), ...(includeLogs ? [logs.refetch()] : [])]),
    setDetail: (detail: HostedTrainingRunDetail) => queries.setQueryData([...key, "core"], detail),
  };
}
