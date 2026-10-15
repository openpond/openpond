import { useState } from "react";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { ChatContextTargetSchema } from "@openpond/contracts";
import { AppDialog } from "../dialogs/AppDialog";
import { ErrorToast } from "../common/ErrorToast";
import { DropdownSelect } from "../DropdownSelect";
import { X } from "../icons";

export function ChatExperimentDraftDialog({ context, onClose }: { context: ReturnType<typeof useChatContextSelection>; onClose: () => void }) {
  const [dataset, setDataset] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = (context.catalog.data?.options ?? []).filter(item => item.target.kind === "dataset");
  async function create() {
    try { await context.select(ChatContextTargetSchema.parse(JSON.parse(dataset)), { newExperiment: true }); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not prepare this experiment."); }
  }
  return <AppDialog ariaLabel="New experiment" className="training-dialog dataset-workspace-dialog" onClose={onClose}>
    <header className="training-dialog-header"><h2>New experiment</h2><button type="button" aria-label="Close dialog" onClick={onClose}><X size={16} /></button></header>
    <DropdownSelect floating label="Experiment dataset" value={dataset}
      options={[{ value: "", label: "Dataset", disabled: true }, ...options.map(item => ({ value: JSON.stringify(item.target), label: item.label, description: item.detail }))]}
      onChange={setDataset} disabled={context.selecting || context.catalog.isPending} />
    <p>Use this dataset and its graders as the starting point. Review the evaluation model in chat before running.</p>
    <ErrorToast error={error ?? context.catalog.error}>{context.catalog.error ? <button type="button" className="training-button secondary" onClick={() => void context.catalog.refetch()}>Retry datasets</button> : null}</ErrorToast>
    <div className="training-dialog-actions"><button type="button" className="training-button secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="training-button" disabled={!dataset || context.selecting} onClick={() => void create()}>Use in experiment</button></div>
  </AppDialog>;
}
