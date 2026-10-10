import {useEffect,useState} from "react";
import type {ChatResourceSummary,LocalDatasetRecord} from "@openpond/contracts";
import type {ClientConnection} from "../../api/api-client";
import {chatResourceRequest} from "../../api/chat-resource-api";
import {RelatedResourceChats} from "./RelatedResourceChats";
import {JsonObjectField,JsonArrayField} from "../datasets/TasksetDraftEditorPrimitives";

type Reply={summary:ChatResourceSummary;record:LocalDatasetRecord;grader:Record<string,unknown>};
export function ChatGraderSummary({initial,connection,context}:{initial:ChatResourceSummary;connection:ClientConnection|null;context?:{sessionId:string;turnId:string}}) {
  const [current,setCurrent]=useState(initial),[reply,setReply]=useState<Reply|null>(null);
  const [expanded,setExpanded]=useState(false),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [grader,setGrader]=useState<Record<string,unknown>|null>(null),[fixtures,setFixtures]=useState<unknown[]>([]),[operation,setOperation]=useState<string|null>(null);
  useEffect(()=>setCurrent(initial),[initial]);
  async function request(action:string,payload:Record<string,unknown>={}) {
    if(!connection || !current.datasetId || !current.graderId)throw new Error("The saved grader reference is unavailable.");
    const result=await chatResourceRequest<Reply>(connection,"dataset",{action,id:current.datasetId,expectedRevision:current.datasetRevision,payload:{graderId:current.graderId,...payload},context});
    setCurrent(result.summary);setReply(result);return result;
  }
  async function perform(action:()=>Promise<void>) {
    if(busy)return;setBusy(true);setError(null);
    try{await action();}catch(error){setError(error instanceof Error ? error.message : "Grader action failed.");}finally{setBusy(false);}
  }
  async function edit() {
    const result=await request("read_grader");setGrader(result.grader);setFixtures(result.record.workspace.draft.graderFixtures);setEditing(true);setExpanded(true);
  }
  const examples=expanded && reply ? reply.record.workspace.draft.graderFixtures.filter(f=>!Array.isArray(f.metadata.graderIds) || f.metadata.graderIds.includes(current.graderId)).map(f=>({id:f.id,label:f.label,detail:JSON.stringify(f.output)})) : current.rows;
  const check=reply?.record.checks.find(c=>c.kind==="graders");
  return <section className="chat-resource-summary" aria-label={`grader: ${current.name}`}>
    <header><div><strong>{current.name}</strong><span>{current.graderType} · Dataset version {current.datasetRevision} · {current.state}</span></div></header>
    <p className="chat-resource-meta">{current.description} · {current.checkState}</p>
    <div className={`training-table-wrap chat-resource-table ${expanded ? "expanded" : ""}`} tabIndex={0} aria-label="Grader examples"><table className="training-data-table evaluation-workspace-table"><thead><tr><th>Example</th><th>Output</th></tr></thead><tbody>{examples.length ? examples.map(row=><tr key={row.id}><td>{row.label}</td><td>{row.detail}</td></tr>) : <tr><td colSpan={2}>No saved examples. Add known-good and known-bad outputs before testing.</td></tr>}</tbody></table></div>
    <div className="chat-resource-actions"><button className="training-button secondary" disabled={!connection || busy} onClick={()=>void perform(async()=>{await request("test_grader");setExpanded(true);})}>Test grader</button><button className="training-button secondary" disabled={!connection || busy} onClick={()=>void perform(async()=>{if(!expanded)await request("read_grader");setExpanded(!expanded);})}>{expanded ? "Collapse" : "View examples"}</button><button className="training-button secondary" disabled={!connection || busy} onClick={()=>void perform(edit)}>Edit</button></div>
    {expanded && check && <div className="chat-resource-checks">{check.issues.filter(issue=>!issue.graderId || issue.graderId===current.graderId).map((issue,index)=><p key={index}>{issue.message}</p>)}</div>}
    {editing && grader && <div className="chat-resource-grader-editor"><p>Save a new Dataset revision. Earlier examples and Experiment inputs stay pinned to their saved version.</p><JsonObjectField label="Grader definition" value={grader} disabled={busy} onChange={value=>{setGrader(value);setOperation(null);}}/><JsonArrayField label="Saved calibration examples" value={fixtures} disabled={busy} onChange={value=>{setFixtures(value);setOperation(null);}}/><div className="chat-resource-actions"><button className="training-button" disabled={busy} onClick={()=>void perform(async()=>{const operationId=operation ?? crypto.randomUUID();setOperation(operationId);const result=await chatResourceRequest<Reply>(connection!,"dataset",{action:"save_grader",id:current.datasetId,expectedRevision:current.datasetRevision,operationId,payload:{grader:{...grader,id:current.graderId},fixtures},context});const summary=result.record.workspace.draft.graders.find(g=>g.id===current.graderId);if(!summary)throw new Error("The original grader was removed; inspect the saved Dataset.");const read=await chatResourceRequest<Reply>(connection!,"dataset",{action:"read_grader",id:current.datasetId,expectedRevision:result.record.workspace.draft.revision,payload:{graderId:summary.id}});setCurrent(read.summary);setReply(read);setEditing(false);setOperation(null);})}>Save revision</button><button className="training-button secondary" disabled={busy} onClick={()=>setEditing(false)}>Close editor</button></div></div>}
    <RelatedResourceChats resource={current} connection={connection}/>
    {error && <p role="alert" className="chat-resource-error">{error}</p>}
  </section>;
}
