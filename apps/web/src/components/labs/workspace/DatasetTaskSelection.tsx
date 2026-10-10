import { useEffect } from "react";
import { useEvaluationSetup, type DatasetRelease } from "./EvaluationSetupState";
import { useWorkspacePanelControls } from "./WorkspacePanel";
import type { ModelsRoute } from "../models-route";
export function useDatasetTaskSelection(release: DatasetRelease | null) {
  const state = useEvaluationSetup();
  const identity = release ? JSON.stringify(release) : null;
  useEffect(() => { if (release) state.activate(release); }, [identity]);
  return state;
}
function useSelectionAction(release: DatasetRelease, route: ModelsRoute) {
  const state = useEvaluationSetup(), controls = useWorkspacePanelControls();
  return { state, show: () => { state.openSelection(release, route); controls?.select({ id: "experiment", label: "Experiment", onSelect: () => {} }); } };
}
export function DatasetTaskSelection({ release, count, route }: { release: DatasetRelease; count: number; route: ModelsRoute }) {
  const { state, show } = useSelectionAction(release, route);
  const selected = state.count(release, count);
  return <input type="checkbox" className="training-chat-checkbox" aria-label="Select all tasks in this Dataset version" disabled={!count} checked={Boolean(count && selected === count)} ref={node => { if(node) node.indeterminate = selected > 0 && selected < count; }} onChange={event => { state.selectAll(release, event.target.checked); if(event.target.checked) show(); }} />;
}
export function DatasetTaskCheckbox({ release, id, route }: { release: DatasetRelease; id: string; route: ModelsRoute }) {
  const { state, show } = useSelectionAction(release, route);
  return <td onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><input type="checkbox" className="training-chat-checkbox" aria-label={`Select task ${id}`} checked={state.selected(release, id)} onChange={event => { state.toggle(release, id, event.target.checked); show(); }} /></td>;
}
