import { useEffect,useMemo,useState } from "react";
import type { ChatResourceSummary } from "@openpond/contracts";
import type { ClientConnection } from "../api/api-client";
import { chatResourceRequest } from "../api/chat-resource-api";
type Index={resources:ChatResourceSummary[];links:{sessionId:string;key:string}[]};
export function useChatResourceIndex(connection:ClientConnection|null) {
  const [index,setIndex]=useState<Index>({resources:[],links:[]});
  const [selected,setSelected]=useState("");
  useEffect(()=>{
    setIndex({resources:[],links:[]});setSelected("");
    if(!connection)return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try{const next=await chatResourceRequest<Index>(connection,"dataset",{action:"resource_index"},abort.signal);if(!abort.signal.aborted)setIndex(next);}
      catch{/* Preserve the last known index while the local server reconnects. */}
      if(!abort.signal.aborted)timer=setTimeout(()=>void load(),15_000);
    };
    void load();return()=>{abort.abort();clearTimeout(timer);};
  },[connection]);
  const sessionIds=useMemo(()=>selected ? new Set(index.links.filter(link=>link.key===selected).map(link=>link.sessionId)) : null,[index.links,selected]);
  const trainingSessionIds=useMemo(()=>new Set(index.links.map(link=>link.sessionId)),[index.links]);
  return {...index,selected,setSelected,sessionIds,trainingSessionIds};
}
