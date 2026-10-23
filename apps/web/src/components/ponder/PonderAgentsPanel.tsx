import { useLayoutEffect, useRef, useState } from "react";
import type { ClientConnection } from "../../api/api-client";
import { localPonderError } from "./local-ponder-error";
import { useErrorToast } from "../../app/AppToastContext";
import { AgentConversation } from "./AgentConversation";
import { ConversationSourceIcon } from "../sidebar/ConversationSourceIcon";
import { ArrowLeft, Cloud } from "../icons";
import { useAgentTranscript } from "./useAgentTranscript";
import type { Session, PonderHostedAssignment } from "@openpond/contracts";
import { HostedAgentDetails, hostedLocation, hostedStateLabels } from "./HostedAgentDetails";
export type AgentPanelItem = {session:Session; status:string; assignment:string; latestActivity:string|null; owner?:"ponder"|"user"};

export function PonderAgentsPanel({connection, accountScopeKey, agents, hostedAgents = [], onControl, onOpenChat, selectionRequest}: {
  connection: ClientConnection; accountScopeKey: string; agents: AgentPanelItem[]; hostedAgents?: PonderHostedAssignment[]; onOpenChat(sessionId:string): Promise<void> | void;
  selectionRequest?: {sessionId:string; version:number};
  onControl(agent: AgentPanelItem, owner: "user" | "ponder"): Promise<void>;
}) {
  const [selection, setSelection] = useState<{kind: "local" | "hosted"; id: string} | null>(null);
  useLayoutEffect(() => {if(selectionRequest)setSelection({kind:"local",id:selectionRequest.sessionId});}, [selectionRequest]);
  const backButton = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const detachedFocusedRow = useRef<string | null>(null);
  const previousSelection = useRef(selection);
  useLayoutEffect(() => {
    if (selection) backButton.current?.focus();
    else if (previousSelection.current) rows.current.get(`${previousSelection.current.kind}:${previousSelection.current.id}`)?.focus();
    previousSelection.current = selection;
  }, [selection]);
  // A polled status change can move a focused worker between list sections.
  useLayoutEffect(() => {
    const key = detachedFocusedRow.current;
    detachedFocusedRow.current = null;
    if (!selection && key && document.activeElement === document.body) rows.current.get(key)?.focus();
  });
  function rememberRow(key: string, element: HTMLButtonElement | null) {
    if (element) rows.current.set(key, element);
    else {
      if (rows.current.get(key) === document.activeElement) detachedFocusedRow.current = key;
      rows.current.delete(key);
    }
  }

  const selected = selection?.kind === "local" ? agents.find(agent => agent.session.id === selection.id) : undefined;
  const selectedHosted = selection?.kind === "hosted" ? hostedAgents.find(agent => agent.id === selection.id) : undefined;
  const history = useAgentTranscript(connection, selected?.session);
  useErrorToast(history.error);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error);
  async function control(agent: AgentPanelItem, owner: "user" | "ponder") {
    setBusy(true);
    try { await onControl(agent, owner); setError(null); }
    catch (cause) { setError(localPonderError(cause)); }
    finally { setBusy(false); }
  }
  async function openChat(agent: AgentPanelItem) {
    setBusy(true);
    try { await onOpenChat(agent.session.id); setError(null); }
    catch (cause) { setError(localPonderError(cause)); }
    finally { setBusy(false); }
  }
  function group(status: string) {
    if (["working", "queued", "preparing", "submitting", "running"].includes(status)) return "Active";
    if (["failed", "waiting_approval", "waiting", "paused", "interrupted", "unknown", "needs_attention"].includes(status)) return "Needs attention";
    return "Done";
  }
  return <section className="ponder-agents-view" aria-label="Pal agents">
    <header>{selected || selectedHosted ? <button ref={backButton} type="button" aria-label="Back to agents" onClick={() => setSelection(null)}><ArrowLeft size={16}/></button> : null}
      <h2>{selectedHosted?.title ?? selected?.session.title ?? "Agents"}</h2></header>
    {selectedHosted ? <HostedAgentDetails connection={connection} accountScopeKey={accountScopeKey} assignment={selectedHosted}/> : selected ? <>
      <div className="ponder-agent-assignment">{selected.session.metadata?.nativeWorkerCanResume === false ? <span>Controlled by its parent conversation · Read-only transcript</span> : null}{selected.owner ? <><span>{selected.owner === "user" ? "You are directing this agent" : "Pal is directing this agent"}</span>
        <button type="button" disabled={busy} onClick={() => void control(selected, selected.owner === "ponder" ? "user" : "ponder")}>{selected.owner === "ponder" ? "Take control" : "Return to Pal"}</button></> : <button type="button" disabled={busy} onClick={() => void openChat(selected)}>{selected.session.metadata?.nativeWorkerCanResume === false ? "Open transcript" : "Open chat"}</button>}</div>
      <AgentConversation connection={connection} conversationId={selected.session.id} messages={history.messages} loading={history.loading}
        running={history.running} hasMore={history.hasMore} loadOlder={async () => (await history.loadOlder()) !== false}/>
    </> : <div className="ponder-agent-list">{agents.length || hostedAgents.length ? ["Active", "Needs attention", "Done"].map(label => {
      const rows = agents.filter(agent => group(agent.status) === label);
      const hostedRows = hostedAgents.filter(agent => group(agent.state) === label);
      return rows.length || hostedRows.length ? <section key={label}><h3>{label}</h3>{rows.map(agent => <div className="ponder-agent-row" key={agent.session.id}>
        <button ref={element => rememberRow(`local:${agent.session.id}`, element)} type="button" onClick={() => setSelection({kind: "local", id: agent.session.id})}><ConversationSourceIcon session={agent.session}/><span>{agent.session.title}{agent.latestActivity || agent.assignment !== agent.session.title ? <small>{agent.latestActivity ?? agent.assignment}</small> : null}</span></button>
        {agent.owner ? <button type="button" disabled={busy} onClick={() => void control(agent, agent.owner === "ponder" ? "user" : "ponder")}>{agent.owner === "ponder" ? "Take control" : "Return"}</button> : <button type="button" disabled={busy} onClick={() => void openChat(agent)}>{agent.session.metadata?.nativeWorkerCanResume === false ? "Open transcript" : "Open chat"}</button>}
      </div>)}{hostedRows.map(agent => <div className="ponder-agent-row" key={`hosted:${agent.id}`}>
        <button ref={element => rememberRow(`hosted:${agent.id}`, element)} type="button" onClick={() => setSelection({kind: "hosted", id: agent.id})}><Cloud size={16}/><span>{agent.title}<small>{hostedLocation(agent)} · {hostedStateLabels[agent.state]}</small></span></button>
        <button type="button" onClick={() => setSelection({kind: "hosted", id: agent.id})}>Open conversation</button>
      </div>)}</section> : null;
    }) : null}</div>}
  </section>;
}
