import { ErrorToast } from "../common/ErrorToast";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChatResourceSummarySchema,
  ChatExperimentViewSchema,
  type ChatResourceSummary,
  type ChatTrainingAttachment,
  type RuntimeEvent,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { ChatTrainingInputs, TrainingWorkspaceSection } from "./ChatTrainingInputs";
import { Plus } from "../icons";
import { chatResourceRequest } from "../../api/chat-resource-api";
import { DatasetRunEvidence, DatasetRunProgress } from "./DatasetRunProgress";
import { DatasetTrainingOverview } from "./DatasetTrainingOverview";
import { DatasetWorkspaceDialog } from "./DatasetWorkspaceDialog";
import { useDatasetWorkspaceRuns } from "./useDatasetWorkspaceRuns";
import { activeRun, datasetWorkspaceContext, resourceIdentity } from "./dataset-workspace-data";
import { addResourceRequestToChat } from "./composer-resource-request";
import "../../styles/training/training.css";
import "../../styles/labs/evaluation-workspace.css";
import "./dataset-workspace.css";

type Resources = ReturnType<typeof useChatResourceFocus>;
export type DatasetWorkspaceDialogState = {
  title: string;
  text?: string;
  run?: ChatResourceSummary;
  training?: ChatTrainingAttachment;
};

export function DatasetWorkspace({
  connection,
  sessionId,
  resources,
  events,
  selectedExperiment,
  experimentName,
}: {
  connection: ClientConnection;
  sessionId: string | null;
  resources: Resources;
  events: RuntimeEvent[];
  selectedExperiment?: ChatResourceSummary | null;
  experimentName?: string;
}) {
  const dataset = resources.focus.dataset,
    datasetKey = dataset ? resourceIdentity(dataset) : "";
  const [dialog, setDialog] = useState<DatasetWorkspaceDialogState | null>(null);
  const collection = useDatasetWorkspaceRuns(selectedExperiment === undefined ? connection : null, dataset, resources.experiments, events);
  const scope = resources.scope;
  const scoped = scope?.ordinal !== null && scope?.ordinal !== undefined;
  const rows = scoped ? collection.rows.filter(run => scope.runs.some(pin => resourceIdentity(pin) === resourceIdentity(run))) : collection.rows;
  const draft = scoped && !scope.runs.length ? scope : null;
  const selected = selectedExperiment !== undefined ? selectedExperiment : draft ? null : rows.find(run => run.id === scope?.selectedRunId)
    ?? rows.find(run => activeRun(run.state)) ?? rows[0] ?? (scoped ? scope.runs.at(-1) ?? null : null);
  const detail = useDatasetRunDetail(connection, selected);
  const currentRun = detail.data?.summary ?? selected;
  useEffect(() => { setDialog(null); }, [datasetKey, scope?.id]);
  const experimentNumber = scope?.ordinal;
  const experimentLabel = experimentName ?? selectedExperiment?.name ?? (selectedExperiment === null ? "Experiment draft" : experimentNumber ? `Experiment ${experimentNumber}` : "Experiment");
  const context = dataset
    ? `${dataset.name}, revision ${dataset.revision}`
    : "the selected Dataset";
  function request(title: string, run?: ChatResourceSummary, training?: ChatTrainingAttachment) {
    if (["Add grader", "New training"].includes(title)) {
      setDialog({ title });
      return;
    }
    const pin = run ? `${dataset?.name}, revision ${run.datasetRevision}, run ${run.id}` : context;
    const text =
      title === "Check graders"
        ? `Test the graders for ${context} against their saved fixtures and known-good and known-bad answers. Report missing coverage and failures separately from model evaluation scores. Do not change the dataset, graders, or start training.`
        : title === "Diagnose"
        ? `Diagnose ${pin}. Inspect its retained results and failures, explain the cause and the next useful step without changing it.`
        : title === "Improve"
          ? `Improve ${pin}. Inspect its retained results, make a targeted change, validate it, and evaluate a comparison within the agreed budget. Preserve the original run and its inputs.`
          : title === "Run experiment"
            ? `Run an experiment on ${context} with its Dataset graders${resources.scope?.evaluationModel ? ` against ${resources.scope.evaluationModel}` : ""}. Use the selected execution destination and agreed budget; ask for any missing model or spending limit before starting.`
            : "Check this training job and show its progress, results, and any model it produced.";
    setDialog({ title, text, run, training });
  }
  function addToChat(text: string) {
    addResourceRequestToChat({
      sessionId,
      text,
      contexts: datasetWorkspaceContext(resources, dialog?.run, dialog?.training),
    });
    setDialog(null);
  }
  return (
    <div className="dataset-workspace" aria-label="Experiment workspace">
      <header className="dataset-workspace-section-heading">
        <div className="dataset-workspace-title">
          <h2>{experimentLabel}</h2>

        </div>
        <div className="dataset-workspace-actions dataset-workspace-header-actions">
          <button type="button" className="training-button secondary" disabled={!dataset} onClick={() => request("Run experiment")}>Evaluate</button>

          <button
            type="button"
            className="training-button secondary dataset-action"
            disabled={!dataset || !currentRun}
            onClick={() => request("Diagnose", currentRun ?? undefined)}
          >
            Diagnose
          </button>
          <button
            type="button"
            className="training-button secondary dataset-action"
            disabled={!dataset || !currentRun || activeRun(currentRun.state)}
            onClick={() => request("Improve", currentRun ?? undefined)}
          >
            Improve
          </button>
          <button
            type="button"
            className="training-button secondary dataset-action"
            disabled={!dataset}
            onClick={() => request("Add grader")}
          >
            <Plus size={13} /> Add grader
          </button>
        </div>
      </header>
      {resources.error ? (
        <ErrorToast error={resources.error} />
      ) : null}
      {!dataset ? (
        <p>Choose an experiment, or create one from a dataset.</p>
      ) : (
        <>
          <p className="dataset-workspace-context"><span>Dataset:</span> {dataset.name} · revision {dataset.revision}</p>
          {currentRun ? (
            <DatasetRunProgress
              key={`progress:${resourceIdentity(currentRun)}`}
              run={currentRun}
              view={detail.data?.view}
              loading={detail.isPending}
              error={detail.error}
              onRefresh={() => void detail.refetch()}
            />
          ) : (
            <p>Evaluate this experiment, or configure a training run below.</p>
          )}
          {collection.history.error ? (
            <ErrorToast error={collection.history.error.message}><button
                type="button"
                className="training-button secondary"
                onClick={() => void collection.history.refetch()}
              >
                Retry
              </button></ErrorToast>
          ) : null}
          <ChatTrainingInputs dataset={dataset} graders={resources.graders} />
          {currentRun ? (
            <TrainingWorkspaceSection title="Results">
            <DatasetRunEvidence
              key={`evidence:${resourceIdentity(currentRun)}`}
              connection={connection}
              run={currentRun}
              view={detail.data?.view}
            />
            </TrainingWorkspaceSection>
          ) : null}
          <TrainingWorkspaceSection title="Training">
          <DatasetTrainingOverview
            connection={connection}
            sessionId={sessionId}
            resources={resources}
            onRequest={request}
          />
          </TrainingWorkspaceSection>
        </>
      )}
      {dialog ? (
        <DatasetWorkspaceDialog
          key={dialog.title}
          dialog={dialog}
          connection={connection}
          resources={resources}
          onClose={() => setDialog(null)}
          onAddToChat={addToChat}
        />
      ) : null}
    </div>
  );
}
function useDatasetRunDetail(connection: ClientConnection, selected: ChatResourceSummary | null) {
  return useQuery({
    queryKey: [
      "dataset-workspace-run",
      connectionQueryScope(connection),
      selected ? resourceIdentity(selected) : null,
    ],
    enabled: Boolean(selected),
    queryFn: async ({ signal }) => {
      const value = await chatResourceRequest<{
        summary: ChatResourceSummary;
        view: import("@openpond/contracts").ChatExperimentView;
      }>(connection, "experiment", { action: "result", payload: { id: selected!.id } }, signal);
      const summary = ChatResourceSummarySchema.parse(value.summary),
        view = ChatExperimentViewSchema.parse(value.view);
      if (
        resourceIdentity(summary) !== resourceIdentity(selected!) ||
        summary.datasetId !== selected!.datasetId ||
        summary.datasetRevision !== selected!.datasetRevision
      )
        throw new Error("Run evidence changed its Dataset pin.");
      return { summary, view };
    },
    refetchInterval: (query) =>
      activeRun(query.state.data?.summary.state ?? selected?.state ?? "") ? 2000 : false,
  });
}
