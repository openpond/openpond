import { OrdinaryExperimentSetupPanel } from "./OrdinaryExperimentSetupPanel";
import { AlphaEditExperimentSetupPanel } from "./AlphaEditExperimentSetupPanel";
import { NeuronTrainingExperimentSetupPanel } from "./NeuronTrainingExperimentSetupPanel";
import { DecisionExperimentSetupPanel } from "./DecisionExperimentSetupPanel";
import { EngramExperimentSetupPanel } from "./EngramExperimentSetupPanel";
import { ErrorToast } from "../../common/ErrorToast";
import { AdvancedRefinerExperimentSetup } from "./AdvancedRefinerExperimentSetup";
import { Activity, useMemo } from "react";
import { TrainingExperimentSetupPanel } from "./TrainingExperimentSetupPanel";
import { ActivationExperimentSetupPanel } from "./ActivationExperimentSetupPanel";
import { useStoredExperimentDraft } from "./useStoredExperimentDraft";
import type { ExperimentDraft } from "openpond-sdk/training";
import { type RunExperiment } from "openpond-sdk/experiments";
import { type ModelsRoute } from "../models-route";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { connectionQueryScope } from "../../../lib/query-scope";
import { WorkspacePanel } from "./WorkspacePanel";
import { workspaceApiForLocation, type Inventory, type WorkspaceApi } from "./workspace-api";

export type ExperimentSetupPanelProps = {
  api: WorkspaceApi;
  inventory: Inventory | null;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
  onSaved: (value: { id: string }) => void;
  dispatch?: (configuration: RunExperiment, operationId: string) => Promise<{ id: string }>;
  onClose?: () => void;
  onAdvancedRun?: (id: string) => void;
  onTrainingStarted?: (id: string) => void | Promise<void>;
  onSaveDraft?: (draft: ExperimentDraft) => Promise<unknown>;
};
export function ExperimentSetupPanel(props: ExperimentSetupPanelProps) {
  const setup = useEvaluationSetup();
  const activationApi = useMemo(() => workspaceApiForLocation(props.api, "hosted"), [props.api]);
  const saveStoredDraft = useStoredExperimentDraft(props.api);
  const onSaveDraft = props.onSaveDraft ?? (props.dispatch ? undefined : saveStoredDraft);
  if (setup.initialExperiment?.hostedEvaluationForm)
    return (
      <WorkspacePanel
        label="Experiment"
        action="experiment"
        onRequestClose={() => {
          setup.close();
          props.onClose?.();
        }}
      >
        <ErrorToast error="Open this saved evaluation in its hosted editor to preserve its native settings." />
        <button
          type="button"
          className="training-button secondary"
          onClick={() => {
            setup.close();
            props.onClose?.();
          }}
        >
          Close editor
        </button>
      </WorkspacePanel>
    );
  if (setup.advancedTarget)
    return (
      <AdvancedRefinerExperimentSetup
        api={props.api}
        target={setup.advancedTarget}
        onClose={() => {
          setup.close();
          props.onClose?.();
        }}
        onOpenRun={props.onAdvancedRun}
      />
    );
  return (
    <>
      <Activity mode={setup.operationType === "evaluate" ? "visible" : "hidden"}>
        <OrdinaryExperimentSetupPanel {...props} onSaveDraft={onSaveDraft} />
      </Activity>
      {(["sft", "grpo"] as const).map((method) => (
        <Activity key={method} mode={setup.operationType === method ? "visible" : "hidden"}>
          <TrainingExperimentSetupPanel
            key={JSON.stringify([
              props.api.key,
              connectionQueryScope(props.api.connection),
              setup.initialExperiment?.id,
              method,
            ])}
            api={props.api}
            method={method}
            visible={setup.operationType === method}
            onStarted={props.onTrainingStarted}
            navigate={props.navigate}
            onSaveDraft={onSaveDraft}
            onClose={() => {
              setup.close();
              props.onClose?.();
            }}
          />
        </Activity>
      ))}
      <Activity mode={setup.operationType === "alphaedit" ? "visible" : "hidden"}>
        <AlphaEditExperimentSetupPanel
          key={`${activationApi.key}:${setup.initialExperiment?.id}:alphaedit`}
          api={activationApi}
          visible={setup.operationType === "alphaedit"}
          onSaveDraft={onSaveDraft}
          onClose={() => {
            setup.close();
            props.onClose?.();
          }}
        />
      </Activity>
      <Activity mode={setup.operationType === "selective_neuron_training" ? "visible" : "hidden"}>
        <NeuronTrainingExperimentSetupPanel
          key={`${activationApi.key}:${setup.initialExperiment?.id}:neuron-training`}
          api={activationApi}
          visible={setup.operationType === "selective_neuron_training"}
          onSaveDraft={onSaveDraft}
          onClose={() => {
            setup.close();
            props.onClose?.();
          }}
        />
      </Activity>
      <Activity mode={setup.operationType === "decision_model" ? "visible" : "hidden"}>
        <DecisionExperimentSetupPanel
          key={`${activationApi.key}:${setup.initialExperiment?.id}:decision`}
          api={activationApi}
          visible={setup.operationType === "decision_model"}
          onSaveDraft={onSaveDraft}
          onClose={() => {
            setup.close();
            props.onClose?.();
          }}
        />
      </Activity>
      <Activity mode={setup.operationType === "engram_adapter" ? "visible" : "hidden"}>
        <EngramExperimentSetupPanel
          key={`${activationApi.key}:${setup.initialExperiment?.id}:engram`}
          api={activationApi}
          visible={setup.operationType === "engram_adapter"}
          onSaveDraft={onSaveDraft}
          onClose={() => {
            setup.close();
            props.onClose?.();
          }}
        />
      </Activity>
      {(["neuron_steering", "inspect_activations"] as const).map((method) => (
        <Activity key={method} mode={setup.operationType === method ? "visible" : "hidden"}>
          <ActivationExperimentSetupPanel
            key={`${activationApi.key}:${setup.initialExperiment?.id}:${method}`}
            api={activationApi}
            method={method}
            visible={setup.operationType === method}
            onSaveDraft={onSaveDraft}
            onClose={() => {
              setup.close();
              props.onClose?.();
            }}
          />
        </Activity>
      ))}
    </>
  );
}
