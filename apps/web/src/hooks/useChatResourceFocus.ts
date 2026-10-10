import { useEffect, useRef, useState } from "react";
import type { ChatResourceSummary } from "@openpond/contracts";
import type { ClientConnection } from "../api/api-client";
import { chatResourceRequest } from "../api/chat-resource-api";
export type ChatResourceFocus = {dataset:ChatResourceSummary|null;experiment:ChatResourceSummary|null};
export function useChatResourceFocus(connection:ClientConnection|null,sessionId:string|null) {
  const [focus,setFocus] = useState<ChatResourceFocus>({dataset:null,experiment:null});
  const [datasets,setDatasets] = useState<ChatResourceSummary[]>([]);
  const [experiments,setExperiments] = useState<ChatResourceSummary[]>([]);
  const [error,setError] = useState<string|null>(null);
  const generation=useRef(0),selection=useRef<AbortController|null>(null);
  useEffect(()=> {
    generation.current++;selection.current?.abort();
    setDatasets([]);setExperiments([]);
    setFocus({dataset:null,experiment:null});setError(null);
    if (!connection || !sessionId) return;
    const abort = new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load = async()=> {
      const admitted=generation.current;
      try {
        const response = await chatResourceRequest<{focus:ChatResourceFocus;datasets:ChatResourceSummary[];experiments:ChatResourceSummary[]}>(connection,"dataset",{action:"context",payload:{sessionId}},abort.signal);
        if (!abort.signal.aborted) {if(admitted===generation.current)setFocus(response.focus);setDatasets(response.datasets);setExperiments(response.experiments);setError(null);}
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Resource context unavailable."); }
      if (!abort.signal.aborted) timer=setTimeout(()=>void load(),10_000);
    };
    void load();return ()=>{generation.current++;selection.current?.abort();abort.abort();clearTimeout(timer);};
  },[connection,sessionId]);
  async function select(kind:"dataset"|"experiment",id:string,revision?:number) {
    if (!connection || !sessionId) return;
    const admitted=++generation.current;selection.current?.abort();const abort=new AbortController();selection.current=abort;
    try {
      const next = await chatResourceRequest<ChatResourceFocus>(connection,"dataset",{action:"set_focus",payload:{sessionId,kind,id:id || null,...revision ? {revision} : {}}},abort.signal);
      if(admitted===generation.current && !abort.signal.aborted){setFocus(next);setError(null);}
    } catch (cause) {if(admitted===generation.current && !abort.signal.aborted)setError(cause instanceof Error ? cause.message : "Focus selection failed.");}
  }
  return {focus,datasets,experiments,select,error};
}
