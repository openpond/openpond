import {useEffect,useRef,useState} from "react";
import {HumanReviewViewSchema,type HumanReviewView,type HumanReviewTransportRequest} from "@openpond/evals/human-review";
import {humanRequest,type HumanInboxContext} from "./api";
export function TaskPublicationControls({context,record,onChanged}:{context:HumanInboxContext;record:HumanReviewView;onChanged:(record:HumanReviewView)=>void}){
  const pending=useRef<HumanReviewTransportRequest|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);const proposalHash=record.decisions.at(-1)?.taskProposalHash;
  const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function publish(){if(!proposalHash)return;setBusy(true);setError(null);try{pending.current??={endpoint:"publish_author",scope:context.scope,id:record.id,expectedRevision:record.revision,operationId:crypto.randomUUID(),proposalHash};const next=HumanReviewViewSchema.parse(await humanRequest(context,pending.current));if(!active.current)return;if(next.id!==record.id||next.scope!==context.scope)throw new Error("Task publication response identity changed.");pending.current=null;onChanged(next);window.dispatchEvent(new Event("human-review-changed"));}catch(e){if(active.current)setError(e instanceof Error?e.message:"Task publication failed.");}finally{if(active.current)setBusy(false);}}
  if(record.authorPublication)return <section><h3>Published task revision</h3><p>{record.authorPublication.dataset.id}, Revision {record.authorPublication.dataset.revision}</p><p>Published by {record.authorPublication.publishedBy}</p></section>;
  if(record.kind!=="author"||record.status!=="accepted")return null;
  return <section><h3>Task publication</h3><p>The accepted proposal is retained separately. Publish it through the source Dataset owner to produce an executable revision.</p>{record.permissions.owner?<button type="button" disabled={busy||!proposalHash} onClick={()=>void publish()}>{pending.current?"Retry same publication":"Publish accepted task proposal"}</button>:<p>The Dataset owner can publish this accepted proposal.</p>}{error?<p role="alert">{error}</p>:null}</section>;
}
