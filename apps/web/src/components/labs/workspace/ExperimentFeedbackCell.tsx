import { useQuery } from "@tanstack/react-query";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "./workspace-api";
type Grader = ExperimentRunDetails["configuration"]["graders"][number];
type Feedback = {
  experimentId: string;
  executionManifestHash: string;
  graders: Array<{
    id: string;
    feedbackKey: string;
    status: "available" | "unavailable";
    mean: number | null;
    count: number;
    total: number;
  }>;
};
export function graderColumnKey(grader: Grader) {
  return JSON.stringify([
    grader.feedbackKey,
    grader.release ?? { id: grader.id, version: grader.version, contentHash: grader.contentHash },
  ]);
}
export function ExperimentFeedbackCell({
  api,
  id,
  manifestHash,
  available,
  graders,
  grader,
}: {
  api: WorkspaceApi;
  id: string;
  manifestHash: string;
  available: boolean;
  graders: Grader[];
  grader: Grader;
}) {
  const selected = graders.find((item) => graderColumnKey(item) === graderColumnKey(grader));
  const summary = useQuery({
    queryKey: ["experiment-feedback-summary", api.key, id, manifestHash],
    enabled: Boolean(selected && available),
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const data =
        api.location === "local"
          ? await api.local<Feedback>("feedbackSummary", { id }, signal)
          : await api.request<Feedback>("feedbackSummary", { id }, signal);
      if (data.experimentId !== id || data.executionManifestHash !== manifestHash)
        throw new Error("These scores belong to another Experiment manifest.");
      return data;
    },
  });
  if (!selected) return <span>—</span>;
  if (!available) return <span>—</span>;
  if (summary.isPending)
    return (
      <span
        role="status"
        className="evaluation-score-skeleton"
        aria-label="Loading retained grader score"
      />
    );
  if (summary.error)
    return (
      <button
        className="training-text-button"
        title={summary.error.message}
        onClick={(event) => {
          event.stopPropagation();
          void summary.refetch();
        }}
      >
        Retry score
      </button>
    );
  const score = summary.data.graders.find(
    (item) => item.id === selected.id && item.feedbackKey === selected.feedbackKey,
  );
  return score?.status === "available" && score.mean !== null ? (
    <span title={`Mean of ${score.count} persisted values in this Experiment`}>
      {score.mean.toFixed(3)} <small>({score.count})</small>
    </span>
  ) : (
    <span
      title={`${score?.count ?? 0} eligible values. Incomplete or categorical feedback has no complete numeric result.`}
    >
      —
    </span>
  );
}
