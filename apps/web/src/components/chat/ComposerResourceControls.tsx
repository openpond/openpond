import { chatTrainingAttachmentKey, type ChatTrainingAttachment } from "@openpond/contracts";
import { inlineErrorMessage } from "../../lib/error-messages";
import { useEffect, useId, useState } from "react";
import { ComposerResourcePanel, type ResourcePanelKind } from "./ComposerResourcePanel";
import { ComposerExperimentSetup } from "./ComposerExperimentSetup";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown, MessageSquare, MoreVertical } from "../icons";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import "./composer-resources.css";

export function ComposerResourceControls({ resources, busy, onDraft }: {
  resources: ReturnType<typeof useChatResourceFocus>; busy: boolean; onDraft: (text: string, training?: ChatTrainingAttachment) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [panel, setPanel] = useState<ResourcePanelKind>("experiment");
  const [hasOpened, setHasOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  function openPanel(next: ResourcePanelKind) { setRenaming(false); setPanel(next); setHasOpened(true); setExpanded(true); }
  const [name, setName] = useState("");
  const { scope, focus } = resources;
  useEffect(() => { setRenaming(false); setExpanded(false); setHasOpened(false); }, [scope?.id]);
  if (!scope) return null;
  const ordinal = scope.ordinal;
  const isExperiment = ordinal !== null;
  const disabled = busy || resources.selecting;
  const dataset = focus.dataset;
  const datasets = dataset ? [dataset, ...resources.datasets.filter(candidate => candidate.id !== dataset.id || candidate.revision !== dataset.revision)] : resources.datasets;
  const grader = resources.graders.find(candidate => candidate.id === scope.selectedGraderId);
  const context = dataset ? `${dataset.name} V${dataset.revision}` : isExperiment ? `experiment ${scope.ordinal}` : "this dataset";
  const run = focus.experiment;
  const running = run && /running|queued|pending|starting/i.test(run.state);
  const completed = run && /completed|complete|succeeded/i.test(run.state);
  const primary = !isExperiment ? "New experiment" : !dataset ? "Add data" : !resources.graders.length ? "Add grader" : running ? "View run" : completed ? "Improve" : "Run";
  const primaryDrafts = !["New experiment", "Add data", "Add grader"].includes(primary);
  function draft(action: string) {
    if (action === "New experiment" || action === "Add data") { openPanel("experiment"); return; }
    if (action === "Create dataset") { openPanel("dataset"); return; }
    if (action === "Add grader") { openPanel("grader"); return; }
    if (action === "Train model") { openPanel("training"); return; }
    if (action === "View rows" && !dataset?.owner && !dataset?.profileRef) { openPanel("rows"); return; }
    const prompts: Record<string, string> = {
      "Test grader": `Test ${grader ? grader.name : "the graders"} on ${context}.`,
      "Run on saved outputs": `Grade this experiment's saved answers with ${grader ? grader.name : "the attached graders"}.`,
      "Run": `Run an experiment on ${context}.`,
      "View run": `How is this experiment going?`,
      "Improve": `How can we improve this experiment's results?`,
      "View rows": `Show the rows in ${context}.`,
      "Improve dataset": `Check ${context} and suggest improvements.`,
      "Compare results": `Compare this experiment with my earlier results.`,
    };
    if (prompts[action]) onDraft(prompts[action]!);
  }
  return <div className={`composer-resource-area ${expanded ? "is-expanded" : ""}`}>
    <div className="composer-resource-bar" aria-label={isExperiment ? "Current experiment" : "Current dataset"}>
      {isExperiment ? <DropdownSelect compact floating placement="top" floatingMenuWidth={280} label="Experiment scope" value={scope.id}
        tooltip={`${scope.ordinal}: ${scope.name}`} className="composer-resource-number"
        triggerContent={<><span>{scope.ordinal}</span><ChevronDown size={12} /></>}
        options={[...(focus.scopeContext?.scopes ?? []).map(candidate => ({ value: candidate.id, label: `${candidate.ordinal}  ${candidate.name}` })), { value: "new", label: "New experiment", icon: "plus" }]}
        onChange={value => { if (value === "new") openPanel("experiment"); else void resources.selectScope(value); setRenaming(false); }} disabled={disabled} /> : null}
      <DropdownSelect compact floating searchable floatingMenuWidth={320} placement="top" label="Dataset focus" className="composer-resource-dataset"
        value={dataset ? `${dataset.id}@${dataset.revision}` : ""}
        triggerContent={<><span className="composer-resource-dataset-name">{dataset?.name ?? "Dataset"}</span>{dataset ? <span className="composer-resource-version">V{dataset.revision}</span> : null}<ChevronDown size={12} /></>}
        tooltip={dataset ? `${dataset.name} V${dataset.revision}` : "Choose a dataset"}
        options={[{ value: "", label: "Choose dataset" }, ...datasets.map(candidate => ({ value: `${candidate.id}@${candidate.revision}`, label: `${candidate.name} V${candidate.revision}`, description: `${candidate.taskCount ?? 0} tasks` })), { value: "create", label: "New dataset…", description: "Describe it in the panel below", icon: "plus" }]}
        onChange={value => { if (value === "create") return draft("Create dataset"); const split = value.lastIndexOf("@"); void resources.select("dataset", split < 0 ? value : value.slice(0, split), split < 0 ? undefined : Number(value.slice(split + 1))); }} disabled={disabled} />
      <DropdownSelect compact floating placement="top" floatingMenuWidth={280} label="Grader focus" className="composer-resource-graders" value={grader?.id ?? ""}
        tooltip={grader?.name ?? `${resources.graders.length} graders`}
        options={[{ value: "", label: "All graders", shortLabel: `Graders ${resources.graders.length}` }, ...resources.graders.map(candidate => ({ value: candidate.id, label: candidate.name })),
          { value: "add", label: "Create grader…", description: "Describe it in the panel below", icon: "plus", disabled: !dataset, separatorBefore: true },
          { value: "test", label: "Test grader…", description: "Draft a request in chat", disabled: !resources.graders.length },
          ...(completed ? [{ value: "score", label: "Run on saved outputs…", disabled: !resources.graders.length }] : [])]}
        onChange={value => { if (value === "add") draft("Add grader"); else if (value === "test") draft("Test grader"); else if (value === "score") draft("Run on saved outputs"); else void resources.select("grader", value); }} disabled={disabled || !dataset} />
      <button type="button" className="composer-resource-primary" title={primaryDrafts ? "Draft a request in chat" : "Open setup below"} onClick={() => draft(primary)} disabled={disabled}>{primaryDrafts ? <MessageSquare size={12} aria-hidden /> : null}{primary}</button>
      <DropdownSelect compact floating placement="top" floatingMenuWidth={250} label="More resource actions" value="" className="composer-resource-more"
        triggerContent={<MoreVertical size={15} />}
        options={[{ value: primary, label: `${primary}…`, description: ["New experiment", "Add data", "Add grader"].includes(primary) ? "Open setup below" : "Draft a request in chat" }, ...(dataset ? [{ value: "View rows", label: "View rows…" }, { value: "Improve dataset", label: "Improve dataset…", description: "Draft a request in chat" }, { value: "Train model", label: "Train on OpenPond…", description: "Prepare hosted model training" }] : []),
          ...(completed ? [{ value: "Run", label: "Run again…" }, { value: "Compare results", label: "Compare results…" }] : []),
          ...(scope.training ?? []).map((training,index)=>({value:`training:${chatTrainingAttachmentKey(training)}`,label:`View training ${index+1}…`,description:training.location === "cloud" ? "Hosted" : "Local",separatorBefore:index===0})),
          ...(isExperiment ? [{ value: "New experiment", label: "New experiment…", separatorBefore: true }, { value: "rename", label: "Rename experiment…" }] : [])]}
        onChange={value => { if (value.startsWith("training:")) {
          const training = scope.training?.find(candidate=>`training:${chatTrainingAttachmentKey(candidate)}`===value);
          if (training) onDraft("Check this training job and show its results and any model it produced.",training);
        } else if (value === "rename") { setName(scope.name); setRenaming(true); setExpanded(true); } else draft(value); }} disabled={disabled} />
      <button type="button" className="composer-resource-expand" aria-label={expanded ? "Collapse resource controls" : "Expand resource controls"}
        aria-expanded={expanded} aria-controls={panelId} onClick={() => { setHasOpened(true); setExpanded(value => !value); }}><ChevronDown size={15} /></button>
    </div>
    <div id={panelId} className="composer-resource-expansion" inert={!expanded} aria-hidden={!expanded}>
      <div className="composer-resource-expansion-inner">
        {!renaming && hasOpened ? panel === "experiment"
          ? <ComposerExperimentSetup resources={resources} busy={busy} onClose={() => setExpanded(false)} onAddGrader={() => openPanel("grader")} />
          : <ComposerResourcePanel key={`${panel}:${dataset?.id}:${dataset?.revision}`} kind={panel} resources={resources} busy={busy}
              onDraft={text => { onDraft(text); setExpanded(false); }} /> : null}
    {renaming ? <div className="composer-resource-rename" onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!disabled && name.trim()) void resources.renameScope(scope.id, name).then(saved => { if (saved) { setRenaming(false); setExpanded(false); } }); } }}>
      <input autoFocus aria-label="Experiment name" value={name} onChange={event => setName(event.target.value)} maxLength={500} disabled={disabled} />
      <button type="button" disabled={disabled || !name.trim()} onClick={() => { void resources.renameScope(scope.id, name).then(saved => { if (saved) { setRenaming(false); setExpanded(false); } }); }}>Save</button><button type="button" onClick={() => { setRenaming(false); setExpanded(false); }}>Cancel</button>
    </div> : null}
      </div>
    </div>
    {resources.error && inlineErrorMessage(resources.error) ? <div role="status" className="chat-resource-error">{resources.error}</div> : null}
  </div>;
}
