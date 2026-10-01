import { useEffect,useState } from "react";
import { z } from "zod";
import { humanRequest,type HumanInboxContext } from "./api";
const Members=z.array(z.object({userId:z.string(),name:z.string().nullable(),email:z.string().nullable()}).passthrough());
export function MemberPicker({context,value,onChange,label="Assignee"}:{context:HumanInboxContext;value:string;onChange:(id:string)=>void;label?:string}){
  const [members,setMembers]=useState<z.infer<typeof Members>>([]),[error,setError]=useState<string|null>(null);
  useEffect(()=>{const controller=new AbortController();setMembers([]);setError(null);if(context.location==="local")return()=>controller.abort();void humanRequest(context,{endpoint:"members",scope:context.scope},controller.signal).then(raw=>{if(!controller.signal.aborted)setMembers(Members.parse(raw));}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[context.scope,context.actorId,context.location,context.connection]);
  return <label>{label}<select value={value} onChange={e=>onChange(e.target.value)}><option value="">Unassigned</option>{context.location==="local"?<option value={context.actorId}>Current account</option>:members.map(m=><option key={m.userId} value={m.userId}>{m.name??m.email??m.userId}</option>)}</select>{error?<small role="alert">{error}</small>:null}</label>;
}
