import { useEvaluationSetup, type DatasetRelease } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import type { ModelsRoute } from "../models-route";

function useSelectionAction(release: DatasetRelease, route: ModelsRoute) {
  const state = useEvaluationSetup(), controls = useWorkspacePanelControls();
  return { state, show: async (action?: { id: string; checked: boolean } | { all: boolean }) => {
    if (!await state.requestSelection(release, route, action)) return;
    controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} });
  } };
}
export function DatasetExperimentButton({ release, route }: { release: DatasetRelease; route: ModelsRoute }) {
  const { show } = useSelectionAction(release, route);
  return <button type="button" className="training-button secondary" onClick={() => void show()}>New experiment</button>;
}
export function DatasetTaskSelection({ release, count, route }: { release: DatasetRelease; count: number; route: ModelsRoute }) {
  const { state, show } = useSelectionAction(release, route);
  const selected = state.count(release, count);
  return <input type="checkbox" className="training-chat-checkbox" aria-label="Select all tasks in this Dataset version" disabled={!count} checked={Boolean(count && selected === count)} ref={node => { if(node) node.indeterminate = selected > 0 && selected < count; }} onChange={event => { void show({ all: event.target.checked }); }} />;
}
export function DatasetTaskCheckbox({ release, id, route }: { release: DatasetRelease; id: string; route: ModelsRoute }) {
  const { state, show } = useSelectionAction(release, route);
  return <td onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><input type="checkbox" className="training-chat-checkbox" aria-label={`Select task ${id}`} checked={state.selected(release, id)} onChange={event => { void show({ id, checked: event.target.checked }); }} /></td>;
}
