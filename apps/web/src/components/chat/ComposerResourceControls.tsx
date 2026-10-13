import { chatTrainingAttachmentKey, type ChatTrainingAttachment } from "@openpond/contracts";
import { inlineErrorMessage } from "../../lib/error-messages";
import { useEffect, useState } from "react";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown, MoreVertical, Plus } from "../icons";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import "./composer-resources.css";

export function ComposerResourceControls({ resources, busy, onDraft }: {
  resources: ReturnType<typeof useChatResourceFocus>; busy: boolean; onDraft: (text: string, training?: ChatTrainingAttachment) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const { scope, focus } = resources;
  useEffect(() => setRenaming(false), [scope?.id]);
  if (!scope) return null;
  const ordinal = scope.ordinal;
  const disabled = busy || resources.selecting;
  const dataset = focus.dataset;
  const datasets = dataset ? [dataset, ...resources.datasets.filter(candidate => candidate.id !== dataset.id || candidate.revision !== dataset.revision)] : resources.datasets;
  const grader = resources.graders.find(candidate => candidate.id === scope.selectedGraderId);
  const context = dataset ? `${dataset.name} V${dataset.revision}` : `experiment ${scope.ordinal}`;
  const run = focus.experiment;
  const running = run && /running|queued|pending|starting/i.test(run.state);
  const completed = run && /completed|complete|succeeded/i.test(run.state);
  const primary = !dataset ? "Add data" : !resources.graders.length ? "Add grader" : running ? "View run" : completed ? "Improve" : "Run";
  function draft(action: string) {
    const prompts: Record<string, string> = {
      "Add data": `Help me choose a dataset for ${context}.`,
      "Create dataset": `Create a dataset for experiment ${ordinal}.`,
      "Add grader": `Add a grader to ${context}.`,
      "Test grader": `Test ${grader ? grader.name : "the graders"} on ${context}.`,
      "Run on saved outputs": `Grade this experiment's saved answers with ${grader ? grader.name : "the attached graders"}.`,
      "Run": `Run an experiment on ${context}.`,
      "View run": `How is this experiment going?`,
      "Improve": `How can we improve this experiment's results?`,
      "Improve dataset": `Check ${context} and suggest improvements.`,
      "Train model": `Help me train a model with ${context}.`,
      "Compare results": `Compare this experiment with my earlier results.`,
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
        triggerContent={<><span className="composer-resource-dataset-name">{dataset?.name ?? "Dataset"}</span>{dataset ? <span className="composer-resource-version">V{dataset.revision}</span> : null}<ChevronDown size={12} /></>}
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
          ...(scope.training ?? []).map((training,index)=>({value:`training:${chatTrainingAttachmentKey(training)}`,label:`View training ${index+1}…`,description:training.location === "cloud" ? "Hosted" : "Local",separatorBefore:index===0})),
          { value: "rename", label: "Rename experiment…", separatorBefore: true }]}
        onChange={value => { if (value.startsWith("training:")) {
          const training = scope.training?.find(candidate=>`training:${chatTrainingAttachmentKey(candidate)}`===value);
          if (training) onDraft("Check this training job and show its results and any model it produced.",training);
        } else if (value === "rename") { setName(scope.name); setRenaming(true); } else draft(value); }} disabled={disabled} />
    </div>
    {renaming ? <form className="composer-resource-rename" onSubmit={event => { event.preventDefault(); void resources.renameScope(scope.id, name).then(saved => { if (saved) setRenaming(false); }); }}>
      <input autoFocus aria-label="Experiment name" value={name} onChange={event => setName(event.target.value)} maxLength={500} disabled={disabled} />
      <button type="submit" disabled={disabled || !name.trim()}>Save</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button>
    </form> : null}
    {resources.error && inlineErrorMessage(resources.error) ? <div role="status" className="chat-resource-error">{resources.error}</div> : null}
  </div>;
}
