import { LearnedModificationResults } from "../labs/workspace/LearnedModificationResults";
import { experimentOperationLabel } from "openpond-sdk/training";
import { ErrorToast } from "../common/ErrorToast";
import { resourceIdentity } from "./dataset-workspace-data";
import { useEffect, useState } from "react";
import type { ClientConnection } from "../../api";
import type { RuntimeEvent } from "@openpond/contracts";
import { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { modelsLocation, modelsPath } from "../labs/models-route";
import { DropdownSelect } from "../DropdownSelect";
import { DatasetWorkspace } from "./DatasetWorkspace";
import { ModelTrainingJourney } from "../labs/ModelTrainingJourney";
import { LocalTrainingOverview } from "./DatasetTrainingOverview";
import { PonderWorkbench } from "./PonderWorkbench";
import { ChatExperimentEditor } from "./ChatExperimentEditor";
import { DecisionResults } from "../labs/workspace/DecisionResults";
import { ChatHostedTrainingResult } from "./ChatHostedTrainingResult";

export function ChatExperimentTool({
  connection,
  sessionId,
  events,
}: {
  connection: ClientConnection;
  sessionId: string | null;
  events: RuntimeEvent[];
}) {
  const context = useChatContextSelection(connection, sessionId);
  const resources = useChatResourceFocus(
    context.selection?.resource || context.selection?.draft ? connection : null,
    sessionId,
  );
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection,
    training = selected?.training;
  const [editingDraft, setEditingDraft] = useState(false);
  useEffect(() => {
    setEditingDraft(false);
  }, [selected?.draft?.id]);
  const draftBaseModel =
    selected?.draft?.startingModel?.baseModel ??
    selected?.draft?.alphaEditForm?.baseModel ??
    selected?.draft?.neuronTrainingForm?.baseModel ??
    selected?.draft?.decisionForm?.baseModel ??
    selected?.draft?.engramForm?.baseModel ??
    selected?.draft?.activationForm?.baseModel ??
    (selected?.draft?.trainingForm
      ? selected.draft.trainingForm.baseModel
      : selected?.draft?.training?.baseModel);
  const draftSpend = selected?.draft?.alphaEditForm
    ? Number(selected.draft.alphaEditForm.maximumSpendUsd)
    : selected?.draft?.neuronTrainingForm
      ? Number(selected.draft.neuronTrainingForm.maximumSpendUsd)
      : selected?.draft?.decisionForm
        ? Number(selected.draft.decisionForm.maximumSpendUsd)
        : selected?.draft?.engramForm
          ? Number(selected.draft.engramForm.maximumSpendUsd)
          : selected?.draft?.activationForm
            ? Number(selected.draft.activationForm.maximumSpendUsd)
            : selected?.draft?.trainingForm
              ? Number(selected.draft.trainingForm.budget)
              : selected?.draft?.training?.maximumSpendUsd;
  const trainingFunding = selected?.draft?.trainingForm?.billingMode === "actual_usage"
    ? { cap: selected.draft.trainingForm.customerCapUsd?.trim() ?? "", planning: selected.draft.trainingForm.budget }
    : selected?.draft?.training?.usageFunding
      ? { cap: selected.draft.training.usageFunding.customerCapUsd ?? "", planning: String(selected.draft.training.maximumSpendUsd) } : null;
  const selectedRun = selected?.resource?.kind === "experiment" ? selected.resource : null;
  const focused = selectedRun ? resources.focus.experiment : resources.focus.dataset;
  const matchesSelection = Boolean(
    selected?.resource &&
    focused &&
    resourceIdentity(selected.resource) === resourceIdentity(focused) &&
    selected.resource.revision === focused.revision,
  );
  const { select } = context;
  const runValue = training ? JSON.stringify(selected!.target) : "";
  const runOptions = (context.runs.data?.runs ?? []).map((run) => ({
    value: JSON.stringify(run.target),
    label: run.label,
    description: run.detail,
  }));
  if (training && !runOptions.some((run) => run.value === runValue))
    runOptions.unshift({
      value: runValue,
      label: `${(training.location === "cloud" ? training.job.createdAt : training.updatedAt).slice(0, 16).replace("T", " ")} UTC`,
      description: training.location === "cloud" ? training.job.state : training.executionState,
    });
  async function choose(raw: string) {
    try {
      setError(null);
      await select(JSON.parse(raw));
    } catch (cause) {
      setError(String(cause));
    }
  }
  const scopedResources = selected?.resource
    ? {
        ...resources,
        focus: {
          ...resources.focus,
          dataset:
            selected.dataset ?? (selected.resource.kind === "dataset" ? selected.resource : null),
          experiment: selectedRun,
        },
        scope:
          (matchesSelection && selectedRun) || selected.target.scopeId === resources.scope?.id
            ? resources.scope
            : null,
        graders: selected.graders ?? [],
      }
    : resources;
  return (
    <div className="chat-experiment-tool">
      <ErrorToast error={error} />
      <PonderWorkbench context={context} connection={connection} sessionId={sessionId} resources={scopedResources}>
      {selected?.alphaEditResult?.result ? (
        <div className="chat-experiment-tool-content">
          <h2>{selected.label}</h2>
          <LearnedModificationResults result={selected.alphaEditResult.result} />
        </div>
      ) : selected?.neuronTrainingResult?.result ? (
        <div className="chat-experiment-tool-content">
          <h2>{selected.label}</h2>
          <LearnedModificationResults result={selected.neuronTrainingResult.result} />
        </div>
      ) : selected?.decisionResult?.result ? (
        <div className="chat-experiment-tool-content">
          <h2>{selected.label}</h2>
          <dl className="training-context-facts">
            <dt>Mode</dt>
            <dd>{selected.decisionResult.mode}</dd>
            <dt>Execution</dt>
            <dd>{selected.decisionResult.id}</dd>
            <dt>Input hash</dt>
            <dd className="saved-model-version-reference">
              {selected.decisionResult.plan.inputHash}
            </dd>
          </dl>
          <DecisionResults result={selected.decisionResult.result} />
        </div>
      ) : selected?.model ? (
        <div className="chat-experiment-tool-content">
          <dl className="training-context-facts">
            <dt>Base model</dt>
            <dd>{selected.model.baseModel ?? "—"}</dd>
          </dl>
          <DropdownSelect
            floating
            label="Training run"
            value={runValue}
            disabled={context.runs.isPending || context.selecting}
            options={[
              ...(!training
                ? [
                    {
                      value: "",
                      label: context.runs.isFetching
                        ? "Loading training runs…"
                        : runOptions.length
                          ? "Choose training run"
                          : "No training runs",
                      disabled: true,
                    },
                  ]
                : []),
              ...runOptions,
            ]}
            onChange={(raw) => void choose(raw)}
          />
          {context.runs.hasNextPage ? <button type="button" className="training-button secondary" disabled={context.runs.isFetchingNextPage} onClick={() => void context.runs.fetchNextPage()}>More training runs</button> : null}
          <ErrorToast error={context.runs.error}>
            {context.runs.error ? (
              <button
                type="button"
                className="training-button secondary"
                onClick={() => void context.runs.refetch()}
              >
                Retry training history
              </button>
            ) : null}
          </ErrorToast>
          {training ? (
            training.location === "cloud" ? (
              <>
                <ModelTrainingJourney
                  compact
                  connection={connection}
                  teamId={training.owner.teamId}
                  projectId={training.job.modelProjectId}
                  jobId={training.jobId}
                  onOpenRun={() =>
                    window.location.assign(
                      modelsPath(
                        modelsLocation("runs", null, {
                          area: "console",
                          resourceId: `hosted-run:${training.jobId}`,
                        }),
                      ),
                    )
                  }
                />
                <ChatHostedTrainingResult connection={connection} training={training} />
              </>
            ) : (
              <LocalTrainingOverview connection={connection} training={training} />
            )
          ) : (
            <p>Choose a training run to inspect its charts and retained results. Open Dataset or Graders to review this model’s configured inputs.</p>
          )}
        </div>
      ) : selected?.draft && (editingDraft || context.configureDraftId === selected.draft.id) ? (
        <ChatExperimentEditor
          connection={connection}
          context={context}
          onClose={() => {
            setEditingDraft(false);
            context.closeDraftEditor();
          }}
        />
      ) : selected?.draft ? (
        <div className="chat-experiment-tool-content">
          <h2>{selected.label}</h2>
          <dl className="training-context-facts">
            <dt>Type</dt>
            <dd>{experimentOperationLabel(selected.draft.operationType)}</dd>
            <dt>Status</dt>
            <dd>Draft</dd>
            {selected.draft.operationType !== "evaluate" ? (
              <>
                <dt>Starting model</dt>
                <dd>{draftBaseModel?.modelId ?? "Not selected"}</dd>
                {selected.draft.startingModel?.source === "alphaedit" ? (
                  <>
                    <dt>Saved AlphaEdit version</dt>
                    <dd className="saved-model-version-reference">
                      {selected.draft.startingModel.alphaedit.versionHash}
                    </dd>
                  </>
                ) : null}
                {selected.draft.startingModel?.source === "neuron_training" ? (
                  <>
                    <dt>Saved neuron training version</dt>
                    <dd className="saved-model-version-reference">
                      {selected.draft.startingModel.neuronTraining.versionHash}
                    </dd>
                  </>
                ) : null}
                {selected.draft.decisionForm ? (
                  <>
                    <dt>Decision mode</dt>
                    <dd>{selected.draft.decisionForm.mode}</dd>
                  </>
                ) : null}
                {selected.draft.startingModel?.source === "decision" ? (
                  <>
                    <dt>Saved Decision version</dt>
                    <dd className="saved-model-version-reference">
                      {selected.draft.startingModel.decision.versionHash}
                    </dd>
                    <dt>Adapter artifact</dt>
                    <dd>{selected.draft.startingModel.decision.artifact.id}</dd>
                  </>
                ) : null}
                {selected.draft.startingModel?.source === "engram" ? (
                  <>
                    <dt>Saved module version</dt>
                    <dd className="saved-model-version-reference">
                      {selected.draft.startingModel.engram.versionHash}
                    </dd>
                    <dt>Module artifact</dt>
                    <dd>{selected.draft.startingModel.engram.artifact.id}</dd>
                  </>
                ) : null}
                {trainingFunding ? <>
                  <dt>Spending limit</dt><dd>{trainingFunding.cap ? `$${trainingFunding.cap}` : "Use available credits"}</dd>
                  <dt>Planning budget</dt><dd>{trainingFunding.planning.trim() ? `$${trainingFunding.planning}` : "Not set"}</dd>
                </> : <>
                <dt>Maximum spend</dt>
                <dd>
                  {typeof draftSpend === "number" && Number.isFinite(draftSpend) && draftSpend > 0
                    ? `$${draftSpend}`
                    : "Not set"}
                </dd>
                </>}
              </>
            ) : null}
          </dl>
          <button
            type="button"
            className="training-button secondary"
            onClick={() => setEditingDraft(true)}
          >
            Configure experiment
          </button>
        </div>
      ) : selected?.resource ||
        (selected?.draft && selected.target.scopeId === resources.scope?.id) ? (
        <DatasetWorkspace
          key={JSON.stringify(selected.target)}
          connection={connection}
          sessionId={sessionId}
          resources={scopedResources}
          events={events}
          showInputs={false}
          selectedExperiment={selectedRun}
          experimentName={selected.target.kind === "dataset" ? "Experiment draft" : selected.label}
        />
      ) : (
        <div className="chat-experiment-tool-content">
          <p>Choose an experiment or model, or start a new experiment.</p>
        </div>
      )}
      </PonderWorkbench>
    </div>
  );
}
