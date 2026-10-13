import { useEffect, useRef, useState } from "react";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { DropdownSelect } from "../DropdownSelect";

export function ComposerExperimentSetup({ resources, busy, onClose, onAddGrader }: {
  resources: ReturnType<typeof useChatResourceFocus>; busy: boolean;
  onClose: () => void; onAddGrader: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [graderId, setGraderId] = useState(resources.scope?.selectedGraderId ?? "");
  const dataset = resources.focus.dataset;
  const disabled = busy || resources.selecting;
  useEffect(() => setGraderId(""), [dataset?.id, dataset?.revision]);
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('.dropdown-trigger:not(:disabled)')?.focus();
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const choices = dataset ? [dataset, ...resources.datasets.filter(item => item.id !== dataset.id || item.revision !== dataset.revision)] : resources.datasets;
  return <div ref={panel} className="composer-experiment-setup" role="region" aria-label="New experiment">
    <div className="composer-experiment-setup-heading"><strong>New experiment</strong><span>Choose the dataset and graders</span></div>
    <DropdownSelect compact floating placement="top" searchable label="Experiment dataset"
      value={dataset ? `${dataset.id}@${dataset.revision}` : ""}
      options={[{ value: "", label: "Choose dataset" }, ...choices.map(item => ({ value: `${item.id}@${item.revision}`, label: `${item.name} V${item.revision}` }))]}
      onChange={value => { const at = value.lastIndexOf("@"); void resources.select("dataset", at < 0 ? "" : value.slice(0, at), at < 0 ? undefined : Number(value.slice(at + 1))); }}
      disabled={disabled} />
    <DropdownSelect compact floating placement="top" label="Experiment grader" value={graderId}
      options={[{ value: "", label: resources.graders.length ? "All graders" : "Choose a grader" },
        ...resources.graders.map(item => ({ value: item.id, label: item.name })),
        { value: "add", label: "Create grader…", icon: "plus", separatorBefore: true }]}
      onChange={value => { if (value === "add") onAddGrader(); else setGraderId(value); }} disabled={disabled || !dataset} />
    <button type="button" className="composer-experiment-create" disabled={disabled || !dataset || !resources.graders.length}
      onClick={() => { void resources.createScope(graderId || null).then(created => { if (created) onClose(); }); }}>Create experiment</button>
  </div>;
}
