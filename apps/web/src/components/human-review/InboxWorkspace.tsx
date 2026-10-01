import {useEffect,useRef,useState} from "react";
import type {HumanReviewView} from "@openpond/evals/human-review";
import {WorkspacePanel,useWorkspaceActions,useWorkspaceResourceName} from "../labs/workspace/WorkspacePanel";
import {humanApi,type HumanInboxContext} from "./api";
import "./human-inbox.css";
import {HumanReviewInspector} from "./HumanReviewInspector";
export function InboxWorkspace({context,projects=[],selectedId,onSelection,projectId:controlledProject,onProjectChange,onConfigureExecution,onOpenExecution}:{context:HumanInboxContext;projects?:{id:string;name:string}[];selectedId?:string|null;onSelection?:(id:string|null)=>void;projectId?:string|null;onProjectChange?:(id:string|null)=>void;onConfigureExecution?:(record:HumanReviewView)=>void;onOpenExecution?:(id:string)=>void}){
  const [view,setView]=useState<"mine"|"team"|"approval">("mine"),[history,setHistory]=useState(false),[localProject,setLocalProject]=useState(""),[items,setItems]=useState<HumanReviewView[]>([]),[selected,setSelected]=useState<HumanReviewView|null>(null),[cursor,setCursor]=useState<string|null>(null),[approval,setApproval]=useState(false),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const projectId=controlledProject===undefined?localProject:controlledProject??"";
  const setProjectId=(id:string)=>{if(onProjectChange)onProjectChange(id||null);else setLocalProject(id);};
  const epoch=useRef(0),priorScope=useRef<string|null>(null),priorQuery=useRef<string|null>(null),key=`${context.scope}:${context.actorId}:${context.location}`;
  useWorkspaceResourceName("Inbox");useWorkspaceActions(selected?[{id:"human-review",label:"Assignment",onSelect:()=>{}}]:[]);
  useEffect(()=>{const controller=new AbortController(),serial=++epoch.current;setLoading(true);setError(null);const queryKey=`${key}:${view}:${history}:${projectId}`;if(priorQuery.current!==queryKey){setItems([]);setCursor(null);priorQuery.current=queryKey;}void humanApi.inbox(context,{view,status:history?"history":"active",...(projectId?{projectId}:{}),limit:50},controller.signal).then(page=>{if(controller.signal.aborted||serial!==epoch.current)return;setItems(page.items);setCursor(page.nextCursor);setApproval(page.approvalAvailable);setSelected(current=>current?page.items.find(r=>r.id===current.id)??current:null);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[key,context.connection,view,history,projectId,refresh]);
  useEffect(()=>{if(priorScope.current!==null&&priorScope.current!==key){setSelected(null);onSelection?.(null);}priorScope.current=key;},[key]);
  useEffect(()=>{const reviewId=selectedId??selected?.id;if(!reviewId)return;const controller=new AbortController();void humanApi.get(context,reviewId,controller.signal).then(record=>{if(!controller.signal.aborted)setSelected(record);}).catch(e=>{if(!controller.signal.aborted){setSelected(null);setError(e.message);}});return()=>controller.abort();},[key,context.connection,selectedId,selected?.id,refresh]);
  useEffect(()=>{const changed=()=>setRefresh(n=>n+1),timer=window.setInterval(()=>{if(document.visibilityState==="visible")changed();},15000);window.addEventListener("human-review-changed",changed);return()=>{clearInterval(timer);window.removeEventListener("human-review-changed",changed);};},[]);
  async function more(){if(!cursor||loading)return;const serial=epoch.current;setLoading(true);try{const page=await humanApi.inbox(context,{view,status:history?"history":"active",...(projectId?{projectId}:{}),afterId:cursor,limit:50});if(serial!==epoch.current)return;setItems(old=>[...old,...page.items.filter(r=>!old.some(o=>o.id===r.id))]);setCursor(page.nextCursor);}catch(e){if(serial===epoch.current)setError(e instanceof Error?e.message:"Inbox request failed.");}finally{if(serial===epoch.current)setLoading(false);}}
  return <section className="human-inbox">
    <header><h1>Inbox</h1><p>{context.location==="local"?"Personal work retained on this computer":"Assignments in the selected workspace"}</p></header>
    <nav className="human-inbox-views" aria-label="Inbox views">
      {(["mine","team",...(approval?["approval"]:[])] as const).map(v=><button className="training-button secondary" type="button" key={v} aria-pressed={view===v} onClick={()=>setView(v as "mine"|"team"|"approval")}>{v==="mine"?"My assignments":v==="team"?"Team queue":"Needs approval"}</button>)}
    </nav>
    <div className="human-inbox-filters">
      <label>Project<select value={projectId} onChange={e=>setProjectId(e.target.value)}>
        <option value="">All Projects</option>
        {projectId&&!projects.some(p=>p.id===projectId)?<option value={projectId}>Selected Project</option>:null}
        {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      <label className="human-inbox-history"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>Completion history</label>
    </div>
    {error?<p role="alert">{error}</p>:null}
    <table><thead><tr><th>Assignment</th><th>Kind</th><th>Status</th><th>Updated</th></tr></thead><tbody>
      {items.map(record=><tr key={record.id}><td><button className="training-button secondary" type="button" onClick={()=>{setSelected(record);onSelection?.(record.id);}}>{record.title}</button></td><td>{record.kind}</td><td>{record.status.replaceAll("_"," ")}</td><td>{record.updatedAt}</td></tr>)}
    </tbody></table>
    {!error&&!items.length&&!loading?<p>No assignments in this view.</p>:null}
    {cursor?<button className="training-button secondary" type="button" disabled={loading} onClick={()=>void more()}>Load more</button>:null}
    {loading?<p role="status">Loading assignments…</p>:null}
    {selected?<WorkspacePanel action="human-review" label={selected.title} onRequestClose={()=>{setSelected(null);onSelection?.(null);}}>
      <HumanReviewInspector key={`${key}:${selected.id}`} context={context} record={selected} onConfigureExecution={onConfigureExecution} onOpenExecution={onOpenExecution} onChanged={record=>{setSelected(record);setRefresh(n=>n+1);}} onClose={()=>{setSelected(null);onSelection?.(null);}}/>
    </WorkspacePanel>:null}
  </section>;
}
