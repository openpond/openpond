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
import { DropdownSelect } from "../DropdownSelect";
import { EvaluationModel, EvaluationStatus } from "../labs/workspace/EvaluationPresentation";
import { ModelTrainingJourney } from "../labs/ModelTrainingJourney";
import { RunFlowDiagram } from "../training/RunFlowDiagram";
import { TrainingMetricWorkbench } from "../training/TrainingMetricWorkbench";
import { metricSeries } from "../training/TrainingRunMetrics";
import { resourceIdentity } from "./dataset-workspace-data";

export function DatasetTrainingOverview({
  connection,
  resources,
  onRequest,
}: {
  connection: ClientConnection;
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
  const [selection, setSelection] = useState<string | null>(null);
  const selected =
    jobs.find((job) => chatTrainingAttachmentKey(job) === selection) ??
    jobs.find((job) => chatTrainingAttachmentKey(job) === resources.scope?.selectedTrainingKey) ??
    jobs.find((job) =>
      job.location === "cloud"
        ? !["completed", "failed", "cancelled", "budget_exhausted"].includes(job.job.state)
        : job.executionState === "running",
    ) ??
    jobs.at(-1);
  return (
    <section className="dataset-workspace-section" aria-label="Dataset training">
      <header className="dataset-workspace-section-heading">
        <div className="dataset-workspace-title">
          <h2>Training</h2>
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
      {!jobs.length ? (
        <div aria-label="Planned training stages">
          <RunFlowDiagram
            live={false}
            nodes={[
              "Prepare",
              "Rollouts",
              "Optimize",
              "Checkpoint",
              "Activate policy",
              "Evaluate",
              "Finish",
            ].map((label) => ({ label, state: "pending" as const, status: "Not started" }))}
          />
        </div>
      ) : (
        <>
          <DropdownSelect
            compact
            floating
            label="Training run"
            value={selected ? chatTrainingAttachmentKey(selected) : ""}
            options={jobs.map((job) => ({
              value: chatTrainingAttachmentKey(job),
              label: job.location === "cloud" ? `Hosted run ${job.jobId.slice(-8)}` : job.modelId,
              description: job.location === "cloud" ? job.job.state : job.executionState,
            }))}
            onChange={setSelection}
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
  if (query.error) return <ErrorToast error={query.error.message} />;
  if (!detail) return <p role="status">Loading training evidence…</p>;
  const recordedUpdates =
    detail.managedEvidence?.progress.committedOptimizerSteps ??
    detail.job.metadata.optimizerUpdatesObserved;
  const updated = typeof recordedUpdates === "number" && recordedUpdates > 0;
  const rolled = detail.events.some(
    (event) => event.type === "metric" && event.payload.metricKind === "rollout_trajectory",
  );
  const success = detail.job.status === "succeeded";
  return (
    <>
      <EvaluationModel name={training.modelId} />
      <RunFlowDiagram
        live={live}
        loopLabel="Training loop"
        nodes={[
          {
            label: "Prepare",
            state: detail.job.startedAt ? "done" : live ? "active" : "pending",
            status: detail.job.startedAt ? "Recorded" : "Waiting",
          },
          {
            label: "Rollouts",
            state: rolled ? "done" : live ? "active" : "pending",
            status: rolled ? "Recorded" : "Waiting for attempts",
            inLoop: true,
          },
          {
            label: "Optimize",
            state: updated ? "done" : "pending",
            status: updated ? "Recorded" : "No recorded updates",
            inLoop: true,
          },
          {
            label: "Finish",
            state: success ? "done" : live ? "pending" : "missing",
            status: detail.job.status,
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
