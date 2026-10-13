import { useEffect, useState } from "react";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown, MoreVertical, Plus } from "../icons";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import "./composer-resources.css";

export function ComposerResourceControls({ resources, busy, onDraft }: {
  resources: ReturnType<typeof useChatResourceFocus>; busy: boolean; onDraft: (text: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const { scope, focus } = resources;
  useEffect(() => setRenaming(false), [scope?.id]);
  if (!scope) return null;
  const disabled = busy || resources.selecting;
  const dataset = focus.dataset;
  const datasets = dataset ? [dataset, ...resources.datasets.filter(candidate => candidate.id !== dataset.id || candidate.revision !== dataset.revision)] : resources.datasets;
  const grader = resources.graders.find(candidate => candidate.id === scope.selectedGraderId);
  const context = `Experiment ${scope.ordinal} (${scope.name})${dataset ? ` using ${dataset.name} V${dataset.revision} (dataset ${dataset.id})` : ""}`;
  const run = focus.experiment;
  const running = run && /running|queued|pending|starting/i.test(run.state);
  const completed = run && /completed|complete|succeeded/i.test(run.state);
  const primary = !dataset ? "Add data" : !resources.graders.length ? "Add grader" : running ? "View run" : completed ? "Improve" : "Run";
  function draft(action: string) {
    const prompts: Record<string, string> = {
      "Add data": `Help me choose or create a dataset for ${context}.`,
      "Create dataset": `Create a new dataset for ${context}.`,
      "Add grader": `Create a grader for ${context}. Inspect its examples and test known-good and known-bad answers.`,
      "Test grader": `Test ${grader ? `${grader.name} (${grader.graderId})` : "the attached graders"} for ${context} using calibration examples.`,
      "Run on saved outputs": `Score the saved outputs of experiment ${run?.id} with ${grader ? `${grader.name} (${grader.graderId})` : "the attached graders"}. Retain a separate scoring result and preserve the original run.`,
      "Run": `Run a new evaluation for ${context} with its attached graders. Use the configured model or help me choose one if missing. Preserve earlier results.`,
      "View run": `Inspect the status and saved evidence of experiment ${run?.id} in ${context}.`,
      "Improve": `Inspect experiment ${run?.id} in ${context}, analyze failed cases, and propose an eligible improvement. Preserve the baseline for comparison.`,
      "Improve dataset": `Review the dataset in ${context} for gaps, duplicates, and missing edge cases. Propose a new revision.`,
      "Train model": `Help me train a model using ${context}. Check compatible models, training-data eligibility, and execution options before starting.`,
      "Compare results": `Compare experiment ${run?.id} in ${context} with a compatible saved experiment using matched inputs.`,
    };
    if (prompts[action]) onDraft(prompts[action]!);
  }
  return <div className="composer-resource-area">
    <div className="composer-resource-bar" aria-label="Current experiment">
      <DropdownSelect compact floating placement="top" floatingMenuWidth={280} label="Experiment scope" value={scope.id}
        tooltip={`${scope.ordinal}: ${scope.name}`} className="composer-resource-number"
        triggerContent={<><span>{scope.ordinal}</span><ChevronDown size={12} /></>}
        options={[...(focus.scopeContext?.scopes ?? []).map(candidate => ({ value: candidate.id, label: `${candidate.ordinal}  ${candidate.name}` })), { value: "new", label: "New experiment", icon: "plus" }]}
        onChange={value => { if (value === "new") void resources.createScope(); else void resources.selectScope(value); setRenaming(false); }} disabled={disabled} />
      <DropdownSelect compact floating searchable floatingMenuWidth={320} placement="top" label="Dataset focus" className="composer-resource-dataset"
        value={dataset ? `${dataset.id}@${dataset.revision}` : ""}
        tooltip={dataset ? `${dataset.name} V${dataset.revision}` : "Choose a dataset"}
        options={[{ value: "", label: "Choose dataset" }, ...datasets.map(candidate => ({ value: `${candidate.id}@${candidate.revision}`, label: `${candidate.name} V${candidate.revision}`, description: `${candidate.taskCount ?? 0} tasks` })), { value: "create", label: "Create dataset…", icon: "plus" }]}
        onChange={value => { if (value === "create") return draft("Create dataset"); const split = value.lastIndexOf("@"); void resources.select("dataset", split < 0 ? value : value.slice(0, split), split < 0 ? undefined : Number(value.slice(split + 1))); }} disabled={disabled} />
      <DropdownSelect compact floating placement="top" floatingMenuWidth={280} label="Grader focus" className="composer-resource-graders" value={grader?.id ?? ""}
        tooltip={grader?.name ?? `${resources.graders.length} graders`}
        options={[{ value: "", label: "All graders", shortLabel: `Graders ${resources.graders.length}` }, ...resources.graders.map(candidate => ({ value: candidate.id, label: candidate.name })),
          { value: "add", label: "Add grader…", icon: "plus", disabled: !dataset, separatorBefore: true },
          { value: "test", label: "Test grader…", disabled: !resources.graders.length },
          ...(completed ? [{ value: "score", label: "Run on saved outputs…", disabled: !resources.graders.length }] : [])]}
        onChange={value => { if (value === "add") draft("Add grader"); else if (value === "test") draft("Test grader"); else if (value === "score") draft("Run on saved outputs"); else void resources.select("grader", value); }} disabled={disabled || !dataset} />
      {dataset && resources.graders.length ? <button type="button" className="composer-resource-add" aria-label="Add grader" data-tooltip="Add a grader" onClick={() => draft("Add grader")} disabled={disabled}><Plus size={14} /></button> : null}
      <button type="button" className="composer-resource-primary" onClick={() => draft(primary)} disabled={disabled}>{primary}</button>
      <DropdownSelect compact floating placement="top" floatingMenuWidth={250} label="More experiment actions" value="" className="composer-resource-more"
        triggerContent={<MoreVertical size={15} />}
        options={[{ value: primary, label: `${primary}…` }, ...(dataset ? [{ value: "Improve dataset", label: "Improve dataset…" }, { value: "Train model", label: "Train model…" }] : []),
          ...(completed ? [{ value: "Run", label: "Run again…" }, { value: "Compare results", label: "Compare results…" }] : []),
          { value: "rename", label: "Rename experiment…", separatorBefore: true }]}
        onChange={value => { if (value === "rename") { setName(scope.name); setRenaming(true); } else draft(value); }} disabled={disabled} />
    </div>
    {renaming ? <form className="composer-resource-rename" onSubmit={event => { event.preventDefault(); void resources.renameScope(scope.id, name).then(saved => { if (saved) setRenaming(false); }); }}>
      <input autoFocus aria-label="Experiment name" value={name} onChange={event => setName(event.target.value)} maxLength={500} disabled={disabled} />
      <button type="submit" disabled={disabled || !name.trim()}>Save</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button>
    </form> : null}
    {resources.error ? <div role="status" className="chat-resource-error">{resources.error}</div> : null}
  </div>;
}
