import { ErrorToast } from "../common/ErrorToast";
import { resourceIdentity } from "./dataset-workspace-data";
import { useEffect, useState } from "react";
import type { ClientConnection } from "../../api";
import type { RuntimeEvent } from "@openpond/contracts";
import { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { modelsLocation, modelsPath } from "../labs/models-route";
import { DropdownSelect } from "../DropdownSelect";
import { ChatContextPicker } from "./ChatContextPicker";
import { DatasetWorkspace } from "./DatasetWorkspace";
import { ModelTrainingJourney } from "../labs/ModelTrainingJourney";
import { LocalTrainingOverview } from "./DatasetTrainingOverview";
import { ChatTrainingInputs, TrainingWorkspaceSection } from "./ChatTrainingInputs";
import { PlannedTrainingFlow } from "../training/RunFlowDiagram";

export function ChatExperimentTool({ connection, sessionId, events }: { connection: ClientConnection; sessionId: string | null; events: RuntimeEvent[] }) {
  const context = useChatContextSelection(connection, sessionId);
  const resources = useChatResourceFocus(context.selection?.resource ? connection : null, sessionId);
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection, training = selected?.training;
  const selectedRun = selected?.resource?.kind === "experiment" ? selected.resource : null;
  const focused = selectedRun ? resources.focus.experiment : resources.focus.dataset;
  const matchesSelection = Boolean(selected?.resource && focused && resourceIdentity(selected.resource) === resourceIdentity(focused)
    && selected.resource.revision === focused.revision);
  const { select } = context;
  const latest = context.runs.data?.runs[0];
  const runValue = training ? JSON.stringify(selected!.target) : "";
  const runOptions = (context.runs.data?.runs ?? []).map(run => ({ value: JSON.stringify(run.target), label: run.label, description: run.detail }));
  if (training && !runOptions.some(run => run.value === runValue)) runOptions.unshift({ value: runValue,
    label: `${(training.location === "cloud" ? training.job.createdAt : training.updatedAt).slice(0, 16).replace("T", " ")} UTC`,
    description: training.location === "cloud" ? training.job.state : training.executionState });
  useEffect(() => {
    if (selected?.target.kind === "model" && latest) {
      void select(latest.target).catch(error => setError(error instanceof Error ? error.message : "Run selection failed."));
    }
  }, [selected?.target.kind, selected?.target.id, latest, select]);
  async function choose(raw: string) { try { setError(null); await select(JSON.parse(raw)); } catch (cause) { setError(String(cause)); } }
  const scopedResources = selected?.resource ? {
    ...resources,
    focus: { ...resources.focus, dataset: selected.dataset ?? (selected.resource.kind === "dataset" ? selected.resource : null), experiment: selectedRun },
    scope: (matchesSelection && selectedRun || selected.target.scopeId === resources.scope?.id) ? resources.scope : null,
    graders: selected.graders ?? [],
  } : resources;
  return <div className="chat-experiment-tool">
    <header className="chat-experiment-tool-header"><ChatContextPicker context={context} /></header>
    <ErrorToast error={error} />
    {selected?.model ? <div className="chat-experiment-tool-content">
      <dl className="training-context-facts"><dt>Base model</dt><dd>{selected.model.baseModel ?? "—"}</dd></dl>
      <DropdownSelect floating label="Training run" value={runValue} disabled={context.runs.isPending || context.selecting}
        options={[...(!runOptions.length ? [{ value: "", label: context.runs.isFetching ? "Loading training runs…" : context.runs.error ? "Choose training run" : "No training runs", disabled: true }] : []),
          ...runOptions]}
        onChange={raw => void choose(raw)} />
      <ErrorToast error={context.runs.error}>{context.runs.error ? <button type="button" className="training-button secondary" onClick={() => void context.runs.refetch()}>Retry training history</button> : null}</ErrorToast>
      {training ? training.location === "cloud" ? <ModelTrainingJourney compact connection={connection} teamId={training.owner.teamId}
        projectId={training.job.modelProjectId} jobId={training.jobId} onOpenRun={() => window.location.assign(modelsPath(modelsLocation("runs", null, { area: "console", resourceId: `hosted-run:${training.jobId}` })))} /> : <LocalTrainingOverview connection={connection} training={training} />
        : <PlannedTrainingFlow />}
      <ChatTrainingInputs connection={connection} dataset={selected.dataset} graders={selected.graders ?? []} model={selected.model} />
      <TrainingWorkspaceSection title="Experiments">
        <DropdownSelect floating label="Experiment" value="" options={[{ value: "", label: "Experiment", disabled: true },
          ...(context.catalog.data?.options ?? []).filter(item => item.target.kind === "experiment").map(item => ({ value: JSON.stringify(item.target), label: item.label, description: item.detail }))]}
          onChange={raw => void choose(raw)} />
      </TrainingWorkspaceSection>
    </div> : selected?.resource ? <DatasetWorkspace key={JSON.stringify(selected.target)} connection={connection} sessionId={sessionId} resources={scopedResources} events={events} selectedExperiment={selectedRun} experimentName={selected.target.kind === "dataset" ? "Experiment draft" : selected.label} />
      : <div className="chat-experiment-tool-content"><p>Choose an experiment or model in Training. Start a new experiment there to choose its dataset.</p></div>}
  </div>;
}
