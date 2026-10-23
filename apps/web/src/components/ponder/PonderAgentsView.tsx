import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { connectionQueryScope } from "../../lib/query-scope";
import { useEffect, useState } from "react";
import type { Session, PonderHostedAssignment } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import { PonderAgentsPanel, type AgentPanelItem } from "./PonderAgentsPanel";
import type { LocalPonderAgent } from "./ponder-local-types";
import { localPonderError } from "./local-ponder-error";

/** Content of the shared right sidebar's Agents tool tab. */
export function PonderAgentsView({connection, ponder, accountScopeKey, parentSessionId, sessions, onOpenChat, selectionRequest}: {
  connection: ClientConnection; ponder: boolean; accountScopeKey: string; parentSessionId: string | null; sessions: readonly Session[];
  selectionRequest?: {sessionId:string; version:number};
  onOpenChat(sessionId:string): void | Promise<unknown>;
}) {
  const [agents,setAgents] = useState<LocalPonderAgent[]>([]);
  const [error,setError] = useState<string|null>(null);
  useErrorToast(error);
  useEffect(() => {
    setAgents([]); setError(null);
    if (!ponder) return;
    let active=true, pending=false;
    async function refresh() {
      if(pending)return;
      pending=true;
      try {
        const response=await apiFetch<{items:LocalPonderAgent[]}>(connection,"/v1/ponder/local/agents");
        if(active){setAgents(response.items);setError(null);}
      }catch(cause){if(active)setError(localPonderError(cause));}
      finally{pending=false;}
    }
    void refresh();const timer=window.setInterval(()=>void refresh(),3000);
    return()=>{active=false;window.clearInterval(timer);};
  },[connection,ponder,accountScopeKey]);
  const hosted = useQuery({
    queryKey: ["ponder-hosted-agents", connectionQueryScope(connection), accountScopeKey], enabled: ponder,
    staleTime: 2000, refetchInterval: ponder ? 5000 : false,
    queryFn: ({signal}) => apiFetch<{items: PonderHostedAssignment[]}>(connection, "/v1/ponder/local/hosted-agents", { signal }),
  });
  useErrorToast(hosted.error);
  const children = useInfiniteQuery({
    queryKey: ["native-agent-children", connectionQueryScope(connection), accountScopeKey, parentSessionId],
    enabled: Boolean(!ponder && parentSessionId), staleTime: 2000, refetchInterval: 3000,
    initialPageParam: {} as { beforeOffset?: number; cursors?: Record<string, string> },
    queryFn: ({ pageParam }) => apiFetch<{ items: Session[]; beforeOffset: number | null; cursors?: Record<string, string> }>(connection, "/v1/native-history/children", {
      method: "POST", body: JSON.stringify({ parentSessionId, ...pageParam }),
    }),
    getNextPageParam: page => page.beforeOffset !== null ? { beforeOffset: page.beforeOffset } :
      page.cursors && Object.keys(page.cursors).length ? { cursors: page.cursors } : undefined,
  });
  useErrorToast(children.error);
  const associated = new Map(sessions.map(session => [session.id, session]));
  for (const page of children.data?.pages ?? []) for (const child of page.items) associated.set(child.id, child);
  const items:AgentPanelItem[]=ponder?agents:[...associated.values()].filter(session=>parentSessionId&&session.parentSessionId===parentSessionId).map(session=>({
    session,status:session.status==="active"?"working":session.status==="failed"?"failed":"idle",
    assignment:session.title,latestActivity:null,
  }));
  async function control(item:AgentPanelItem,owner:"user"|"ponder") {
    const current=agents.find(agent=>agent.session.id===item.session.id);
    if(!current)throw new Error("This agent has no Pal control relationship.");
    const updated=await apiFetch<LocalPonderAgent>(connection,`/v1/ponder/local/agents/${encodeURIComponent(item.session.id)}/control`,{
      method:"POST",body:JSON.stringify({owner,revision:current.revision}),
    });
    setAgents(rows=>rows.map(row=>row.session.id===updated.session.id?updated:row));
    if(owner==="user")await onOpenChat(item.session.id);
  }
  async function openChat(sessionId: string) {
    const session = items.find(item => item.session.id === sessionId)?.session;
    if (session?.metadata?.nativeWorker && session.hiddenFromDefaultSidebar) {
      const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
      await apiFetch(connection, path, { method: "PATCH", body: JSON.stringify({ hiddenFromDefaultSidebar: false }) });
    }
    await onOpenChat(sessionId);
  }
  return <><PonderAgentsPanel selectionRequest={selectionRequest} key={ponder?`ponder:${accountScopeKey}`:parentSessionId} connection={connection} accountScopeKey={accountScopeKey} agents={items} hostedAgents={ponder ? hosted.data?.items ?? [] : []} onControl={control} onOpenChat={openChat}/>{!ponder && children.hasNextPage ? <button type="button" disabled={children.isFetchingNextPage} onClick={() => void children.fetchNextPage()}>Load earlier agents</button> : null}</>;
}
