import { useEffect, useRef } from "react";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
import { DropdownSelect } from "../DropdownSelect";

export function ComposerExperimentSetup({ resources, busy, onClose, onAddGrader, onRows, createNew }: {
  resources: ReturnType<typeof useChatResourceFocus>; busy: boolean;
  createNew:boolean; onRows:()=>void; onClose: () => void; onAddGrader: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const dataset = resources.focus.dataset;
  const disabled = busy || resources.selecting;
  const model = resources.scope?.evaluationModel;
  const available = resources.models.some(item=>`${item.providerId}/${item.id}`===model);
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('.dropdown-trigger:not(:disabled)')?.focus();
  }, []);
  return <div ref={panel} className="composer-experiment-setup" role="region" aria-label={createNew ? "New experiment" : "Experiment configuration"}>
    <div className="composer-experiment-setup-heading"><strong>{createNew ? "New experiment" : "Configuration"}</strong><span>{dataset ? `Uses ${resources.graders.length} dataset grader${resources.graders.length===1?"":"s"}` : "Choose a dataset above"}</span></div>
    <DropdownSelect compact floating placement="top" searchable label="Evaluation model" value={model ?? ""}
      options={[{value:"",label:resources.modelsLoading ? "Loading models…" : "Choose evaluation model",disabled:true},
        ...(model && !available ? [{value:model,label:`${model} (unavailable)`,disabled:true}] : []),
        ...resources.models.map(item=>({value:`${item.providerId}/${item.id}`,label:item.name??item.id,description:item.providerId})),
        {value:"refresh",label:"Refresh models",separatorBefore:true}]}
      onChange={value=>{if(value==="refresh")resources.refreshModels();else void resources.selectModel(value);}} disabled={disabled||resources.modelsLoading}/>
    {dataset && !dataset.owner && !dataset.profileRef ? <button type="button" className="composer-resource-secondary" onClick={onRows} disabled={disabled}>Rows</button>:null}
    {!resources.graders.length ? <button type="button" className="composer-resource-secondary" onClick={onAddGrader} disabled={disabled||!dataset}>Create grader</button> : createNew ?
      <button type="button" className="composer-experiment-create" disabled={disabled || !dataset || !available}
        onClick={() => { void resources.createScope(null).then(created => { if (created) onClose(); }); }}>Create experiment</button>:null}
    {resources.modelsError ? <span role="status" className="chat-resource-error">{resources.modelsError}</span>:null}
  </div>;
}
