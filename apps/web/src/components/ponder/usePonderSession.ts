import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import type { ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { openEventStream } from "../../api/event-stream";
import { IncrementalChatProjector } from "../../lib/incremental-chat-projector";
import { mergePonderHistoryEvents, ponderHistoryPage, type PonderHistorySnapshot } from "./ponder-history-cache";
import type { RuntimeEvent } from "@openpond/contracts";

const EMPTY_EVENTS:RuntimeEvent[]=[];

/** Render cached local history immediately, then resume at its exact replay cursor. */
export function usePonderSession(connection:ClientConnection,sessionId:string|null) {
  const queries=useQueryClient();
  const scope=connectionQueryScope(connection);
  const key=useMemo(()=>["ponder-history",scope,sessionId] as const,[scope,sessionId]);
  const projector=useRef(new IncrementalChatProjector());
  const history=useQuery({queryKey:key,enabled:Boolean(sessionId),staleTime:Infinity,gcTime:10*60*1000,
    queryFn:async()=>ponderHistoryPage(await api.runtimeEventsPage(connection,{sessionId,beforeSequence:Number.MAX_SAFE_INTEGER,limit:200})),
  });
  const [older,setOlder]=useState<{key:typeof key;loading:boolean;error:string|null}|null>(null);
  const ready=Boolean(history.data);
  useEffect(()=>{
    if(!sessionId||!ready)return;
    const snapshot=queries.getQueryData<PonderHistorySnapshot>(key);
    if(!snapshot)return;
    const stream=openEventStream(connection,event=>{
      if(event.sessionId!==sessionId)return;
      queries.setQueryData<PonderHistorySnapshot>(key,current=>current?mergePonderHistoryEvents(current,[event]):current);
    },()=>{/* The shell owns connection outage notifications. */},undefined,{
      afterSequence:snapshot.cursor,
      fetchImpl:(input,init)=>{
        const url=new URL(String(input));url.searchParams.set("sessionId",sessionId);return fetch(url,init);
      },
    });
    return()=>stream.close();
  },[connection,sessionId,ready,key,queries]);
  async function loadOlder(){
    const snapshot=queries.getQueryData<PonderHistorySnapshot>(key);
    if(!sessionId||!snapshot?.hasMore||(older?.key===key&&older.loading))return false;
    setOlder({key,loading:true,error:null});
    try{
      const page=ponderHistoryPage(await api.runtimeEventsPage(connection,{sessionId,beforeSequence:snapshot.before,limit:200}));
      queries.setQueryData<PonderHistorySnapshot>(key,current=>current?{
        ...mergePonderHistoryEvents(current,page.events),before:page.before,hasMore:page.hasMore,
      }:current);
      setOlder({key,loading:false,error:null});
      return page.events.length > 0;
    }catch(cause){setOlder({key,loading:false,error:cause instanceof Error?cause.message:String(cause)});return false;}
  }
  const events=history.data?.events??EMPTY_EVENTS;
  const messages=useMemo(()=>projector.current.project(events),[events]);
  const latest=[...events].reverse().find(event=>["turn.started","turn.completed","turn.failed","turn.interrupted"].includes(event.name));
  return {events,messages,error:older?.key===key&&older.error?older.error:history.error?.message??null,
    loading:(Boolean(sessionId)&&history.isPending)||(older?.key===key&&older.loading===true),
    hasMore:history.data?.hasMore??false,loadOlder,running:latest?.name==="turn.started"};
}
