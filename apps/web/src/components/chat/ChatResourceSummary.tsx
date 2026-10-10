import { useEffect, useState } from "react";
import type { ChatResourceSummary as Resource, ChatExperimentView } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { chatResourceRequest, type DatasetResponse } from "../../api/chat-resource-api";
import { RelatedResourceChats } from "./RelatedResourceChats";
import { ChatGraderSummary } from "./ChatGraderSummary";
import { DropdownSelect } from "../DropdownSelect";
import "../../styles/training/training.css";
import "./chat-resources.css";

type ModelChoice = {id:string;name:string;providerId:string};
export function ChatResourceSummary(props:{initial:Resource;connection:ClientConnection|null;context?:{sessionId:string;turnId:string}}) {
  return props.initial.kind === "grader" ? <ChatGraderSummary {...props}/> : <ChatDatasetOrExperimentSummary {...props}/>;
}
function ChatDatasetOrExperimentSummary({initial,connection,context}:{initial:Resource;connection:ClientConnection|null;context?:{sessionId:string;turnId:string}}) {
  const [current,setCurrent] = useState(initial);
  const [expanded,setExpanded] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [details,setDetails] = useState<DatasetResponse|ChatExperimentView|null>(null);
  const [setup,setSetup] = useState(false);
  const [models,setModels] = useState<ModelChoice[]>([]);
  const [model,setModel] = useState("");
  const [selectedModels,setSelectedModels]=useState<string[]>([]);
  const [budget,setBudget] = useState("");
  const [taskLimit,setTaskLimit] = useState("10");
  const [launched,setLaunched] = useState<Resource[]>([]);
  const [location,setLocation]=useState<"local"|"cloud">(initial.location ?? "local");
  const [operationId,setOperationId] = useState<string|null>(null);
  const [meteredGrading,setMeteredGrading]=useState(true);
  const selectedKeys=[...new Set([...selectedModels,...model ? [model] : []])];
  const subscriptionOnly=location === "local" && !meteredGrading && selectedKeys.length>0 && selectedKeys.every(key=>key.startsWith("codex/"));
  const [chartOperationId] = useState(()=>crypto.randomUUID());
  useEffect(()=>setCurrent(initial),[initial]);
  const unsaved=["Creating","Importing","Failed","Cancelled"].includes(current.state) && current.kind === "dataset";
  // Refresh runtime state without changing a historical dataset revision.
  useEffect(()=> {
    if (!connection || unsaved || current.kind === "experiment" && !["queued","running","cancelling"].includes(current.state)) return;
    const abort = new AbortController(); let timer:ReturnType<typeof setTimeout>;
    const poll = async()=> {
      try {
        const reply = current.kind === "dataset" ? await chatResourceRequest<DatasetResponse>(connection,"dataset",{action:"read",id:current.id,expectedRevision:current.revision},abort.signal) : await chatResourceRequest<{summary:Resource;view:ChatExperimentView}>(connection,"experiment",{action:"status",payload:{id:current.id}},abort.signal);
        if (!abort.signal.aborted) { setCurrent(previous=>({...reply.summary,datasetId:previous.datasetId,datasetRevision:previous.datasetRevision}));setDetails("record" in reply ? reply : reply.view);setError(null); }
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Status unavailable."); }
      if (!abort.signal.aborted) timer = setTimeout(()=>void poll(),current.kind === "dataset" ? 10_000 : 2000);
    };
    void poll(); return ()=>{abort.abort();clearTimeout(timer);};
  },[connection,current.id,current.kind,current.state,current.revision,unsaved]);
  async function perform(action:()=>Promise<void>) {
    if (busy || !connection) return;
    setBusy(true);setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Resource action failed."); }
    finally { setBusy(false); }
  }
  async function datasetAction(action:string,payload:Record<string,unknown>={}) {
    const response = await chatResourceRequest<DatasetResponse>(connection!,"dataset",{action,id:current.id,expectedRevision:current.revision,payload,context});
    setCurrent(response.summary);setDetails(response);
  }
  async function view() {
    if (expanded) {setExpanded(false);return;}
    if (current.kind === "dataset") {
      const response = await chatResourceRequest<DatasetResponse>(connection!,"dataset",{action:"read",id:current.id,expectedRevision:current.revision});setDetails(response);
    } else {
      const response = await chatResourceRequest<{view:ChatExperimentView}>(connection!,"experiment",{action:"result",payload:{id:current.id}});setDetails(response.view);
    }
    setExpanded(true);
  }
  async function prepareRun() {
    const datasetId=current.kind === "dataset" ? current.id : current.datasetId;
    const revision=current.kind === "dataset" ? current.revision : current.datasetRevision;
    if(!datasetId || !revision)throw new Error("The saved Dataset pin is unavailable.");
    const [response,dataset]=await Promise.all([chatResourceRequest<{models:ModelChoice[]}>(connection!,"experiment",{action:"models"}),chatResourceRequest<DatasetResponse>(connection!,"dataset",{action:"read",id:datasetId,expectedRevision:revision})]);
    setMeteredGrading(dataset.record.workspace.draft.graders.some(grader=>grader.kind === "model_judge"));
    setModels(response.models);setSelectedModels([]);setModel(""); setSetup(true);
    if (response.models.length === 1) setModel(`${response.models[0].providerId}/${response.models[0].id}`);
  }
  async function run() {
    const keys=[...new Set([...selectedModels,...model ? [model] : []])];
    const selected = keys.map(key=>models.find(m=>`${m.providerId}/${m.id}` === key));
    const maximumCostUsd = Number(budget),limit=Number(taskLimit);
    if (location === "cloud" && selected.some(model=>model?.providerId!=="openpond"))throw new Error("Cloud execution requires available OpenPond models.");
    if (!selected.length || selected.length>8 || selected.some(model=>!model) || !subscriptionOnly && (!Number.isFinite(maximumCostUsd) || maximumCostUsd <= 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Select a model, a task count from 1 to 100, and a positive total budget for metered calls.");
    const operation = operationId ?? crypto.randomUUID(); setOperationId(operation);
    const datasetId = current.kind === "dataset" ? current.id : current.datasetId;
    const revision = current.kind === "dataset" ? current.revision : current.datasetRevision;
    if (!datasetId || !revision) throw new Error("This Experiment does not have an installation-local Dataset pin.");
    const response = await chatResourceRequest<{summaries:Resource[]}>(connection!,"experiment",{action:location === "cloud" ? "run_cloud" : "run",context,payload:{datasetId,revision,operationId:operation,...subscriptionOnly ? {} : {maximumCostUsd},taskLimit:limit,models:selected.map(model=>({providerId:model!.providerId,modelId:model!.id}))}});
    if (!context) setLaunched(response.summaries);setSetup(false);setOperationId(null);
  }
  const rows = expanded && details ? "record" in details ? details.record.workspace.draft.tasks.map(t=>({id:t.id,label:typeof t.input.prompt === "string" ? t.input.prompt : JSON.stringify(t.input),detail:details.record.workspace.draft.graders.map(g=>g.label).join(", "),score:undefined})) : details.cases.map(c=>({id:c.id,label:c.taskId,detail:c.error ?? c.output ?? c.status,score:c.score})) : current.rows;
  return <section className="chat-resource-summary" aria-label={`${current.kind}: ${current.name}`}>
    <header><div><strong>{current.name}</strong><span>Version {current.revision} · {current.state}</span></div>
      {current.kind === "dataset" && !unsaved && current.syncState !== "Synced" && current.syncState !== "Paused" && <button type="button" className="training-button secondary" disabled={!connection || busy || unsaved} onClick={()=>void perform(()=>datasetAction(current.syncState === "Local" ? "upload" : "sync"))}>{current.syncState === "Local" ? "Upload to cloud" : "Retry sync"}</button>}
    </header>
    <p className="chat-resource-meta">{current.kind === "dataset" ? `${current.taskCount ?? 0} saved tasks · ${current.graderCount ?? 0} graders · ${current.syncState ?? "Local"} · ${current.checkState ?? "Not checked"}` : `${current.location ?? "local"} · ${current.model ?? ""} · ${current.evaluatedCount ?? 0}/${current.taskCount ?? 0} graded · ${current.scoreLabel ?? "Mean task score"} ${current.score == null ? "Unavailable" : `${(current.score*100).toFixed(1)}%`} · Cost ${current.costUsd == null ? "Unavailable" : `$${current.costUsd.toFixed(4)}`}`}</p>
    {current.kind === "experiment" && <p className="chat-resource-meta">{current.qualityFailureCount ?? 0} quality failures · {current.executionFailureCount ?? 0} execution failures · {current.ungradedCount ?? current.taskCount ?? 0} ungraded</p>}
    <div className={`training-table-wrap chat-resource-table ${expanded ? "expanded" : ""}`} tabIndex={0} aria-label="Resource rows">
      <table className="training-data-table evaluation-workspace-table"><thead><tr><th>{current.kind === "dataset" ? "Task" : "Case"}</th><th>{current.kind === "dataset" ? "Graders" : "Outcome"}</th>{current.kind === "experiment" && <th>Score</th>}</tr></thead>
        <tbody>{rows.length ? rows.map(row=><tr key={row.id}><td>{row.label}</td><td>{row.detail}</td>{current.kind === "experiment" && <td>{row.score == null ? "Unavailable" : `${(row.score*100).toFixed(1)}%`}</td>}</tr>) : <tr><td colSpan={current.kind === "experiment" ? 3 : 2}>{["Creating","Importing"].includes(current.state) ? "Waiting for saved tasks…" : "No saved rows to show."}</td></tr>}</tbody>
      </table>
    </div>
    <div className="chat-resource-actions">
      {current.kind === "dataset" ? <><button type="button" className="training-button secondary" disabled={busy || !connection || unsaved} onClick={()=>void perform(prepareRun)}>Run experiment</button><button type="button" className="training-button secondary" disabled={busy || !connection || unsaved} onClick={()=>void perform(()=>datasetAction("check_graders"))}>Check graders</button></> : ["queued","running","cancelling"].includes(current.state) ? <button type="button" className="training-button secondary" disabled={busy || !connection} onClick={()=>void perform(async()=>{const response=await chatResourceRequest<{summary:Resource}>(connection!,"experiment",{action:"cancel",payload:{id:current.id}});setCurrent(previous=>({...response.summary,datasetId:previous.datasetId,datasetRevision:previous.datasetRevision}));})}>Cancel experiment</button> : null}
      <button type="button" className="training-button secondary" disabled={busy || !connection || unsaved} onClick={()=>void perform(view)}>{expanded ? "Collapse" : current.kind === "dataset" ? "View all" : "View results"}</button>
      {current.kind === "experiment" && !["queued","running","cancelling"].includes(current.state) && <><button type="button" className="training-button secondary" disabled={busy || !connection || !current.datasetId} onClick={()=>void perform(prepareRun)}>Run again</button><button type="button" className="training-button secondary" disabled={busy || !connection || !context} onClick={()=>void perform(async()=>{await chatResourceRequest(connection!,"experiment",{action:"charts",context,payload:{ids:[current.id],operationId:chartOperationId}});})}>HTML charts</button></>}
      {expanded && current.kind === "dataset" && !unsaved && current.syncState !== "Local" && <><button type="button" className="training-button secondary" disabled={busy || !connection} onClick={()=>void perform(()=>datasetAction("pause_sync",{paused:current.syncState !== "Paused"}))}>{current.syncState === "Paused" ? "Resume sync" : "Pause sync"}</button><button type="button" className="training-button secondary" disabled={busy || !connection} onClick={()=>void perform(()=>datasetAction("disconnect_sync"))}>Disconnect cloud</button></>}
    </div>
    {setup && <div className="chat-resource-run-setup"><p>Run the saved Dataset, version {current.kind === "dataset" ? current.revision : current.datasetRevision}. The total budget includes model calls and grading.{location === "cloud" ? " Cloud execution publishes this exact revision and enables Dataset sync." : ""}</p>
      <DropdownSelect label="Execution location" value={location} options={[{value:"local",label:"Local"},{value:"cloud",label:"Cloud",description:"Publish this saved version and run in the linked workspace"}]} onChange={value=>{setLocation(value as "local"|"cloud");setSelectedModels([]);setModel("");setOperationId(null);}} disabled={busy}/>
      <DropdownSelect label="Evaluated model" value={model} options={[{value:"",label:"Select model"},...models.filter(model=>location === "local" || model.providerId === "openpond").map(m=>({value:`${m.providerId}/${m.id}`,label:m.name,description:m.providerId}))]} onChange={value=>{setModel(value);setOperationId(null);}} disabled={busy} />
      <button type="button" className="training-button secondary" disabled={busy || !model || selectedModels.includes(model) || selectedModels.length>=8} onClick={()=>{setSelectedModels([...selectedModels,model]);setModel("");setOperationId(null);}}>Add model</button>
      {selectedModels.length>0 && <table className="training-data-table"><thead><tr><th>Selected model</th><th>Actions</th></tr></thead><tbody>{selectedModels.map(key=><tr key={key}><td>{models.find(model=>`${model.providerId}/${model.id}`===key)?.name ?? key}</td><td><button type="button" className="training-text-button" disabled={busy} onClick={()=>{setSelectedModels(selectedModels.filter(value=>value!==key));setOperationId(null);}}>Remove</button></td></tr>)}</tbody></table>}
      {!models.length && <p>Sign in to Codex or configure a supported local inference endpoint, a priced OpenPond model, or Claude API provider in Settings before running.</p>}
      {subscriptionOnly ? <p>Uses your signed-in Codex account with Lite reasoning. No dollar budget is required. Token usage is retained; dollar cost is unavailable.</p> : <label>Total budget (USD)<input type="number" min="0.000001" step="any" value={budget} onChange={event=>{setBudget(event.target.value);setOperationId(null);}} disabled={busy} /></label>}
      <label>Maximum tasks<input type="number" min="1" max="100" value={taskLimit} onChange={event=>{setTaskLimit(event.target.value);setOperationId(null);}} disabled={busy} /></label>
      <button type="button" className="training-button" disabled={busy || !selectedModels.length && !model || !subscriptionOnly && !budget} onClick={()=>void perform(run)}>{location === "cloud" ? "Run in cloud" : "Run experiment"}</button><button type="button" className="training-button secondary" disabled={busy} onClick={()=>setSetup(false)}>Close</button>
    </div>}
    {expanded && details && "record" in details && <div className="chat-resource-checks">{details.record.checks.map(check=><div key={check.kind}><strong>{check.kind}: {check.workspaceHash === details.record.workspace.contentHash ? check.status : "Stale"}</strong><p>{check.checked}/{check.total} checked</p>{check.issues.map((issue,index)=><p key={index}>{issue.message}</p>)}</div>)}</div>}
    <RelatedResourceChats resource={current} connection={connection}/>
    {error && <p role="alert" className="chat-resource-error">{error}</p>}
    {launched.map(resource=><ChatResourceSummary key={resource.id} initial={resource} connection={connection} />)}
  </section>;
}
