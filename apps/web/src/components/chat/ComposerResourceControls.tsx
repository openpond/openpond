import { DropdownSelect } from "../DropdownSelect";
import type { useChatResourceFocus } from "../../hooks/useChatResourceFocus";
export function ComposerResourceControls({resources,busy}:{resources:ReturnType<typeof useChatResourceFocus>;busy:boolean}) {
  const pinned=resources.focus.dataset;
  const datasets=pinned ? [pinned,...resources.datasets.filter(dataset=>dataset.id!==pinned.id || dataset.revision!==pinned.revision)] : resources.datasets;
  const experiment=resources.focus.experiment;
  const experiments=experiment ? [experiment,...resources.experiments.filter(candidate=>candidate.id!==experiment.id)] : resources.experiments;
  return <>
    <DropdownSelect compact label="Dataset focus" value={pinned ? `${pinned.id}@${pinned.revision}` : ""} options={[{value:"",label:"Dataset"},...datasets.map(d=>({value:`${d.id}@${d.revision}`,label:`${d.name} · v${d.revision}`,description:`Version ${d.revision} · ${d.taskCount ?? 0} tasks`}))]} onChange={value=>{const split=value.lastIndexOf("@");void resources.select("dataset",split<0 ? value : value.slice(0,split),split<0 ? undefined : Number(value.slice(split+1)));}} disabled={busy} />
    <DropdownSelect compact label="Experiment focus" value={experiment?.id ?? ""} options={[{value:"",label:"Experiment"},...experiments.map(e=>({value:e.id,label:e.name,description:e.state}))]} onChange={id=>void resources.select("experiment",id)} disabled={busy} />
    {resources.error && <span role="status" className="chat-resource-error">{resources.error}</span>}
  </>;
}
