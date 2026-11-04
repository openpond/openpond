import { ErrorToast } from "../../common/ErrorToast";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ExperimentDraft } from "openpond-sdk/training";
import type { ClientConnection } from "../../../api/api-client";
import { modelsLocation, type ModelsRoute } from "../models-route";
import { EvaluationSetupProvider, useEvaluationSetup } from "./EvaluationSetupState";
import { WorkspacePanelControls, useWorkspaceActions, type EvaluationSidebarControl } from "./WorkspacePanel";
import { ExperimentWorkspaceFrame } from "./ExperimentWorkspaceFrame";
import { ExperimentSetupPanel } from "./ExperimentSetupPanel";
import { createWorkspaceApi, type Inventory } from "./workspace-api";

type Props = { children: ReactNode; draft: ExperimentDraft; connection: ClientConnection; teamId: string; actorId: string;
  accountKey: string; route: ModelsRoute; onClose: () => void; navigate: (route: ModelsRoute) => void;
  onSidebarControl?: (control: EvaluationSidebarControl | null) => void };
export function ModelExperimentWorkspace(props: Props) {
  return <EvaluationSetupProvider initialExperiment={props.draft} allowedOperationTypes={["sft", "grpo", "neuron_steering", "inspect_activations", "engram_adapter", "decision_model", "alphaedit", "selective_neuron_training"]}>
    <WorkspacePanelControls onControl={props.onSidebarControl}><Content {...props} /></WorkspacePanelControls>
  </EvaluationSetupProvider>;
}
function Content(props: Props) {
  const setup = useEvaluationSetup();
  useWorkspaceActions([{ id: "experiment", label: "Experiment", onSelect: () => {} }]);
  const api = useMemo(() => createWorkspaceApi(props.connection, { teamId: props.teamId, actorId: props.actorId,
    accountKey: props.accountKey, projectId: props.route.projectId ?? null, executionLocation: "hosted" }),
    [props.connection, props.teamId, props.actorId, props.accountKey, props.route.projectId]);
  const inventory = useQuery({ queryKey: ["evaluation-workspace", api.key, "model-experiment-inventory"],
    queryFn: ({ signal }) => api.request<Inventory>("inventory", {}, signal) });
  return <ExperimentWorkspaceFrame>{props.children}{inventory.error ? <ErrorToast error={inventory.error}><button type="button" className="training-button secondary" onClick={() => void inventory.refetch()}>Reload workspace</button></ErrorToast> : null}{setup.draft ? <ExperimentSetupPanel key={setup.initialExperiment?.id} api={api} inventory={inventory.data ?? null}
    route={props.route} navigate={props.navigate} onClose={props.onClose}
    onSaved={value => props.navigate(modelsLocation("experiments", null, { area: props.route.area, resourceId: value.id, executionLocation: "hosted", projectId: api.projectId }))} /> : null}</ExperimentWorkspaceFrame>;
}
