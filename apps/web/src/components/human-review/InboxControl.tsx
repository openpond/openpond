import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { humanApi, type HumanInboxContext } from "./api";
export function InboxControl({ context, onOpen }: {context:HumanInboxContext;onOpen:()=>void}) {
  const [count,setCount]=useState<number|null>(null);
  useEffect(()=>{
    const controller=new AbortController();let serial=0;
    async function refresh(){const order=++serial;try{const result=await humanApi.inbox(context,{view:"mine",status:"active",limit:1},controller.signal);if(!controller.signal.aborted&&order===serial)setCount(result.actionCount);}catch{if(!controller.signal.aborted&&order===serial)setCount(null);}}
    setCount(null);void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh();},15000);
    window.addEventListener("human-review-changed",refresh);
    return()=>{controller.abort();window.clearInterval(timer);window.removeEventListener("human-review-changed",refresh);};
  },[context.scope,context.actorId,context.location,context.connection]);
  return <button type="button" className="evaluation-panel-icon" aria-label={count?`Inbox, ${count} actions`:"Inbox"} onClick={onOpen}><Inbox size={16}/>{count? <span>{count}</span>:null}</button>;
}
