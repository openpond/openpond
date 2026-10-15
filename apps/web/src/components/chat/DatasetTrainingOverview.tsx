import { ErrorToast } from "../common/ErrorToast";
import { Plus } from "../icons";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  chatResourceWorkspaces,
  chatTrainingAttachmentKey,
  TrainingRunDetailSchema,
  type ChatTrainingAttachment,
} from "@openpond/contracts";
import { api } from "../../api";
import type { ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { DropdownSelect } from "../DropdownSelect";
import { EvaluationModel, EvaluationStatus } from "../labs/workspace/EvaluationPresentation";
import { ModelTrainingJourney } from "../labs/ModelTrainingJourney";
import { PlannedTrainingFlow, RunFlowDiagram } from "../training/RunFlowDiagram";
import { TrainingMetricWorkbench } from "../training/TrainingMetricWorkbench";
import { metricSeries } from "../training/TrainingRunMetrics";
import { resourceIdentity } from "./dataset-workspace-data";

export function DatasetTrainingOverview({
  connection,
  sessionId,
  resources,
  onRequest,
}: {
  connection: ClientConnection;
  sessionId: string | null;
  resources: ReturnType<typeof useChatResourceFocus>;
  onRequest: (title: string, run?: undefined, training?: ChatTrainingAttachment) => void;
}) {
  const dataset = resources.focus.dataset;
  const jobs =
    resources.focus.scopeContext && dataset
      ? [
          ...new Map(
            chatResourceWorkspaces(resources.focus.scopeContext)
              .filter(
                (scope) =>
                  scope.id === resources.scope?.id && scope.dataset && resourceIdentity(scope.dataset) === resourceIdentity(dataset),
              )
              .flatMap((scope) => scope.training ?? [])
              .map((job) => [chatTrainingAttachmentKey(job), job]),
          ).values(),
        ]
      : [];
  const context = useChatContextSelection(connection, sessionId);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selected =
    jobs.find((job) => chatTrainingAttachmentKey(job) === resources.scope?.selectedTrainingKey) ??
    jobs.find((job) =>
      job.location === "cloud"
        ? !["completed", "failed", "cancelled", "budget_exhausted"].includes(job.job.state)
        : job.executionState === "running",
    ) ??
    jobs.at(-1);
  async function selectTraining(key: string) {
    const training = jobs.find((job) => chatTrainingAttachmentKey(job) === key);
    if (!training) return;
    setSelectionError(null);
    try {
      await context.select({ kind: "training", id: training.jobId, location: training.location,
        ...(training.location === "cloud" ? { teamId: training.owner.teamId, apiOrigin: training.apiOrigin } : {}),
      });
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Run selection failed.");
    }
  }
  return (
    <section className="dataset-workspace-section" aria-label="Dataset training">
      <header className="dataset-workspace-section-heading">
        <div className="dataset-workspace-title">
          <h2>{jobs.length ? "Training runs" : "Planned stages"}</h2>
          <button
            type="button"
            className="training-button secondary icon-only"
            aria-label="New training"
            title="New training"
            onClick={() => onRequest("New training")}
          >
            <Plus size={15} />
          </button>
        </div>
        {selected ? (
          <EvaluationStatus
            status={selected.location === "cloud" ? selected.job.state : selected.executionState}
          />
        ) : null}
      </header>
      <ErrorToast error={selectionError} />
      {!jobs.length ? (
        <div aria-label="Planned training stages">
          <PlannedTrainingFlow />
        </div>
      ) : (
        <>
          <DropdownSelect
            compact
            floating
            label="Training run"
            value={selected ? chatTrainingAttachmentKey(selected) : ""}
            disabled={context.selecting}
            options={jobs.map((job) => ({
              value: chatTrainingAttachmentKey(job),
              label: job.location === "cloud" ? `Hosted run ${job.jobId.slice(-8)}` : job.modelId,
              description: job.location === "cloud" ? job.job.state : job.executionState,
            }))}
            onChange={(value) => void selectTraining(value)}
          />
          {selected?.location === "cloud" ? (
            <ModelTrainingJourney
              key={chatTrainingAttachmentKey(selected)}
              compact
              connection={connection}
              teamId={selected.owner.teamId}
              projectId={selected.job.modelProjectId}
              jobId={selected.jobId}
              onOpenRun={() => onRequest("Check training", undefined, selected)}
            />
          ) : selected ? (
            <LocalTrainingOverview
              key={chatTrainingAttachmentKey(selected)}
              connection={connection}
              training={selected}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

export function LocalTrainingOverview({
  connection,
  training,
}: {
  connection: ClientConnection;
  training: Extract<ChatTrainingAttachment, { location: "local" }>;
}) {
  const query = useQuery({
    queryKey: [
      "dataset-workspace-training",
      connectionQueryScope(connection),
      chatTrainingAttachmentKey(training),
    ],
    queryFn: async () => {
      const value = TrainingRunDetailSchema.parse(
        await api.trainingRunDetail(connection, training.jobId),
      );
      if (value.job.id !== training.jobId)
        throw new Error("Training evidence does not match the attached job.");
      return value;
    },
    refetchInterval: (query) =>
      ["queued", "starting", "running", "reconciling", "cancelling"].includes(
        query.state.data?.job.status ?? training.executionState,
      )
        ? 3000
        : false,
  });
  const detail = query.data,
    live = Boolean(
      detail &&
      ["queued", "starting", "running", "reconciling"].includes(detail.job.status) &&
      !query.error,
    );
  if (!detail) return <><ErrorToast error={query.error?.message} /><p role="status">Loading training evidence…</p><button type="button" className="training-button secondary" onClick={() => void query.refetch()}>Refresh</button></>;
  const recordedUpdates =
    detail.managedEvidence?.progress.committedOptimizerSteps ??
    detail.job.metadata.optimizerUpdatesObserved;
  const updated = typeof recordedUpdates === "number" && recordedUpdates > 0;
  const rolled = detail.events.some(
    (event) => event.type === "metric" && event.payload.metricKind === "rollout_trajectory",
  );
  const success = detail.job.status === "succeeded";
  const graded = detail.events.filter((event) => event.type === "metric" && event.payload.metricKind === "rollout_trajectory" && typeof event.payload.reward === "number" && Number.isFinite(event.payload.reward)).length;
  const checkpoint = detail.events.some((event) => event.type === "checkpoint") || Boolean(detail.managedEvidence?.checkpoint?.sha256);
  const evaluated = Boolean(detail.evaluation) || Boolean(detail.managedEvidence?.evaluations.some((evaluation) => evaluation.kind === "candidate"));
  const unrecorded = live ? "pending" as const : "missing" as const;
  const prepared = rolled || updated || checkpoint || evaluated;
  return (
    <>
      <EvaluationModel name={training.modelId} />
      <ErrorToast error={query.error?.message} />
      <RunFlowDiagram
        live={live}
        loopLabel="Training loop"
        nodes={[
          {
            label: "Prepare",
            state: prepared ? "done" : live ? "active" : unrecorded,
            status: prepared ? "Recorded" : detail.job.startedAt ? "Worker started" : "Waiting",
          },
          {
            label: "Rollouts",
            state: rolled ? "done" : unrecorded,
            status: rolled ? "Recorded" : "Waiting for attempts",
            inLoop: true,
          },
          {
            label: "Grade",
            compute: "cpu",
            state: graded ? "done" : unrecorded,
            status: graded ? "Recorded" : "No recorded grades",
            detail: graded ? `${graded} graded attempts` : undefined,
            inLoop: true,
          },
          {
            label: "Update adapter",
            state: updated ? "done" : unrecorded,
            status: updated ? "Recorded" : "No recorded updates",
            detail: updated ? `${recordedUpdates} updates` : undefined,
            inLoop: true,
          },
          {
            label: "Save checkpoint",
            compute: "cpu",
            state: checkpoint ? "done" : unrecorded,
            status: checkpoint ? "Recorded" : "No saved checkpoint recorded",
            inLoop: true,
          },
          {
            label: "Evaluate",
            state: evaluated ? "done" : unrecorded,
            status: evaluated ? "Recorded" : "No candidate evaluation recorded",
          },
          {
            label: "Finish",
            state: success ? "done" : detail.job.status === "failed" ? "failed" : unrecorded,
            status: detail.job.status,
            error: detail.job.error ?? undefined,
          },
        ]}
      />
      <TrainingMetricWorkbench series={metricSeries(detail)} />
      <details className="dataset-workspace-logs">
        <summary>Training events</summary>
        <ol>
          {detail.events.slice(-100).map((event) => (
            <li key={event.id}>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              <span>
                {typeof event.payload.message === "string" ? event.payload.message : event.type}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}
