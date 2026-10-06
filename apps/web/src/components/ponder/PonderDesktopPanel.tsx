import { useEffect, useRef, useState } from "react";
import type { ChatAttachment, Session } from "@openpond/contracts";
import { ApiRequestError, apiFetch, type ClientConnection } from "../../api/api-client";
import type { ChatMessage } from "../../lib/app-models";
import { Composer, type ComposerProps } from "../chat/Composer";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";
import { PonderRecommendations } from "./PonderRecommendations";
import { usePonderRecommendations } from "./usePonderRecommendations";
import type { PonderRecommendation } from "./ponder-recommendations";
import { usePonderLocalMessage } from "./usePonderLocalMessage";
import { PonderLocalMessageControl } from "./PonderLocalMessageControl";

type Binding = { bindingId: string; conversationId: string; introductionSeenVersion: number };
type Message = { id: string; role: string; text: string; createdAt: string; source: string | null };
type Turn = { id: string; status: string; lastSequence: number; wait?: { id: string; kind: string; title: string; options: string[] } | null;
  outputs?: Array<{ id: string; name: string; downloadURL?: string | null }> };
type Conversation = { id: string; messages: Message[]; activeTurn: Turn | null };
type TurnEvent = { id: string; sequence: number; type: string; text: string | null };
type InputRef = { id: string; name: string; contentType: string; sizeBytes: number };
type Upload = { input: InputRef; upload: { url: string; method: string; headers: Record<string, string> } };
type LinkedWork = { conversationId: string; title: string; status: string };

type SharedComposerProps = Pick<ComposerProps,
  "contextWindowStatus" | "providerSettings" | "provider" | "model" | "projectTarget" |
  "workspaceTarget" | "codexPermissionMode" | "codexReasoningEffort" |
  "openPondCommandAccessMode" | "onProviderChange" | "onProviderSetupOpen" |
  "onProjectTargetChange" | "onWorkspaceTargetChange" | "onModelChange" |
  "onCodexPermissionModeChange" | "onCodexReasoningEffortChange" |
  "onOpenPondCommandAccessModeChange" | "showToast"
>;

function displayError(cause: unknown): string {
  if (cause instanceof ApiRequestError &&
      (cause.message === "public_api_route_not_found" || cause.message === "product_route_not_found")) {
    return "Ponder Pal is available in this app, but the connected OpenPond service has not been updated yet.";
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function conversationMessages(conversation: Conversation | null): ChatMessage[] {
  return (conversation?.messages ?? []).filter((message) => (message.role === "user" || message.role === "assistant") && message.source !== "ponder-recommendation")
    .map((message) => ({ id: message.id, role: message.role as "user" | "assistant",
      content: message.text, timestamp: message.createdAt }));
}

export function PonderDesktopPanel({ connection, presentation, composer, onOpenWork, sessions }: {
  connection: ClientConnection;
  presentation: "clean" | "activity";
  composer: SharedComposerProps;
  onOpenWork: (conversationId: string) => void;
  sessions: Session[];
}) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [waitResponse, setWaitResponse] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<TurnEvent[]>([]);
  const [linkedWork, setLinkedWork] = useState<LinkedWork[]>([]);
  const activityCursor = useRef<string | null>(null);
  const recommendations = usePonderRecommendations(connection, binding?.bindingId ?? null);
  const [editingRecommendation, setEditingRecommendation] = useState<PonderRecommendation | null>(null);
  const localMessage = usePonderLocalMessage(connection, binding?.bindingId ?? null);
  const chatDraft = useRef("");
  const activeContext = useRef({ connection, bindingId: binding?.bindingId, destination: localMessage.sessionId ?? editingRecommendation?.id ?? "chat", draft });
  activeContext.current = { connection, bindingId: binding?.bindingId, destination: localMessage.sessionId ?? editingRecommendation?.id ?? "chat", draft };
  const submitting = useRef(false);
  const mounted = useRef(true);
  function returnToChat() {
    localMessage.select(null);
    setEditingRecommendation(null);
    setDraft(chatDraft.current);
  }
  function editRecommendation(item: PonderRecommendation) {
    if (!localMessage.sessionId && !editingRecommendation) chatDraft.current = draft;
    localMessage.select(null);
    setEditingRecommendation(item);
    setDraft(item.proposedText ?? "");
  }
  function chooseLocalTarget(id: string | null) {
    if (!id) { returnToChat(); return; }
    if (!localMessage.sessionId && !editingRecommendation) chatDraft.current = draft;
    setEditingRecommendation(null);
    localMessage.select(id);
    setDraft("");
  }
  async function recommendationAction(item: PonderRecommendation, action: "send" | "dismiss") {
    const context = activeContext.current;
    const wasEditing = editingRecommendation?.id === item.id;
    const sent = await recommendations.action(item, action, action === "send" ? wasEditing ? draft : item.proposedText ?? undefined : undefined);
    if (sent && wasEditing && activeContext.current.connection === context.connection && activeContext.current.bindingId === context.bindingId && activeContext.current.destination === context.destination) {
      // Preserve edits made while an action was awaiting acknowledgment.
      if (activeContext.current.draft === context.draft) returnToChat();
      else setEditingRecommendation(null);
    }
  }

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setBinding(null);
    setConversation(null);
    setEvents([]);
    setLinkedWork([]);
    activityCursor.current = null;
    setError(null);
    setDraft("");
    chatDraft.current = "";
    setSending(false);
    setWaitResponse("");
    setEditingRecommendation(null);
    void apiFetch<Binding>(connection, "/v1/ponder", { method: "POST", body: "{}" })
      .then((value) => { if (active) { setBinding(value); setError(null); } })
      .catch((cause) => { if (active) setError(displayError(cause)); });
    return () => { active = false; mounted.current = false; };
  }, [connection]);

  useEffect(() => {
    if (!binding) return;
    let active = true;
    const refresh = async () => {
      try {
        const value = await apiFetch<Conversation>(connection, `/v1/ponder/conversations/${encodeURIComponent(binding.conversationId)}`);
        if (active) setConversation(value);
      } catch (cause) { if (active) setError(displayError(cause)); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [connection, binding]);

  useEffect(() => {
    if (!binding) return;
    let active = true;
    const refresh = async () => {
      try {
        const value = await apiFetch<{ items: LinkedWork[] }>(connection, "/v1/ponder/work");
        if (active) setLinkedWork(value.items);
      } catch (cause) { if (active) setError(displayError(cause)); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [connection, binding]);

  useEffect(() => {
    if (!binding || presentation !== "activity") return;
    activityCursor.current = null;
    setEvents([]);
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        let more: boolean;
        do {
          const after = activityCursor.current;
          const page = await apiFetch<{ items: TurnEvent[]; nextCursor: string | null; hasMore: boolean }>(
            connection, `/v1/ponder/conversations/${encodeURIComponent(binding.conversationId)}/activity${after ? `?after=${encodeURIComponent(after)}` : ""}`);
          if (!active) return;
          if (page.items.length > 0) {
            setEvents((current) => [...current, ...page.items]);
            activityCursor.current = page.nextCursor;
          }
          more = page.hasMore && page.items.length > 0;
        } while (more);
      } catch (cause) { if (active) setError(displayError(cause)); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [connection, binding, presentation]);

  async function uploadAttachment(attachment: ChatAttachment): Promise<InputRef> {
    const bytes = attachment.contentsBase64
      ? Uint8Array.from(atob(attachment.contentsBase64), (character) => character.charCodeAt(0))
      : attachment.text !== undefined ? new TextEncoder().encode(attachment.text) : null;
    if (!bytes) throw new Error(`Attachment ${attachment.name} has no content to upload.`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256Base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const created = await apiFetch<Upload>(connection, "/v1/ponder/work-inputs", {
      method: "POST", body: JSON.stringify({ name: attachment.name,
        contentType: attachment.mediaType, sizeBytes: bytes.byteLength, sha256Base64 }),
    });
    const uploaded = await fetch(created.upload.url, {
      method: created.upload.method, headers: created.upload.headers, body: new Blob([bytes], { type: attachment.mediaType }),
    });
    if (!uploaded.ok) throw new Error(`Attachment upload failed (${uploaded.status})`);
    return apiFetch<InputRef>(connection,
      `/v1/ponder/work-inputs/${encodeURIComponent(created.input.id)}/finalize`, { method: "POST", body: "{}" });
  }

  async function send(attachments: ChatAttachment[] = [], options?: { promptOverride?: string }): Promise<boolean> {
    const prompt = (options?.promptOverride ?? draft).trim();
    if (!binding || !prompt || submitting.current) return false;
    const context = activeContext.current;
    const stillCurrent = () => mounted.current && activeContext.current.connection === context.connection && activeContext.current.bindingId === context.bindingId && activeContext.current.destination === context.destination;
    submitting.current = true;
    setSending(true);
    try {
      if (localMessage.sessionId || editingRecommendation) {
        if (attachments.length) throw new Error("Send task messages as text. Attachments can be sent in the task's own conversation.");
        const sent = localMessage.sessionId ? await localMessage.send(prompt) : await recommendations.action(editingRecommendation!, "send", prompt);
        if (!stillCurrent()) return false;
        if (sent && activeContext.current.draft === context.draft) {
          if (editingRecommendation) returnToChat();
          else setDraft("");
        }
        return sent;
      }
      const inputs = await Promise.all(attachments.map(uploadAttachment));
      if (!stillCurrent()) return false;
      await apiFetch(connection, `/v1/ponder/conversations/${encodeURIComponent(binding.conversationId)}/turns`, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ prompt, attachments: inputs }),
      });
      if (!stillCurrent()) return false;
      if (activeContext.current.draft === context.draft) setDraft("");
      setError(null);
      return true;
    } catch (cause) { if (stillCurrent()) setError(displayError(cause)); return false; }
    finally { submitting.current = false; setSending(false); }
  }

  async function resolveWait(turn: Turn, response: { value: string } | { decision: "accepted" | "declined" }) {
    if (!turn.wait) return;
    try {
      await apiFetch(connection, `/v1/ponder/turns/${encodeURIComponent(turn.id)}/waits/${encodeURIComponent(turn.wait.id)}/resolve`, {
        method: "POST", body: JSON.stringify(response),
      });
      setWaitResponse("");
    } catch (cause) { setError(displayError(cause)); }
  }

  async function stop(turn: Turn) {
    try {
      await apiFetch(connection, `/v1/ponder/turns/${encodeURIComponent(turn.id)}/cancel`, {
        method: "POST", body: "{}",
      });
    } catch (cause) { setError(displayError(cause)); }
  }

  async function openOutput(outputId: string) {
    const tab = window.open("about:blank", "_blank");
    try {
      const output = await apiFetch<{ downloadURL: string | null }>(connection,
        `/v1/ponder/work-outputs/${encodeURIComponent(outputId)}`);
      if (!output.downloadURL) throw new Error("This output is not available for download.");
      if (tab) tab.location.replace(output.downloadURL);
      else window.location.assign(output.downloadURL);
    } catch (cause) {
      tab?.close();
      setError(displayError(cause));
    }
  }

  const running = Boolean(conversation?.activeTurn && ["queued", "running", "retry_scheduled"].includes(conversation.activeTurn.status));
  const messages = conversationMessages(conversation);
  const activity: ChatMessage | null = presentation === "activity" && events.length > 0
    ? { id: "ponder-activity", role: "activity_group", timestamp: new Date().toISOString(),
      activities: events.map((event) => ({ id: event.id, label: event.type,
        content: event.text ?? "", timestamp: new Date().toISOString() })) }
    : null;

  return <div className="chat-column" aria-label="Ponder Pal">
    <section className="chat-thread" aria-label="Conversation">
      {linkedWork.length > 0 && <section className="ponder-linked-work" aria-label="Ponder Pal Work tasks">
        {linkedWork.map((item) => <button key={item.conversationId} type="button"
          onClick={() => onOpenWork(item.conversationId)}>
          <span>{item.title}</span><small>{item.status.replaceAll("_", " ")}</small>
        </button>)}
      </section>}
      {messages.map((message) => <MessageRow key={message.id} message={message} connection={connection} />)}
      <PonderRecommendations items={recommendations.items} busy={recommendations.busy} editingId={editingRecommendation?.id ?? null}
        onEdit={editRecommendation}
        onSend={item => { void recommendationAction(item, "send"); }}
        onDismiss={item => { void recommendationAction(item, "dismiss"); }}
        onOpen={onOpenWork} />
      {recommendations.error ? <p role="alert">{recommendations.error}</p> : null}
      {activity && <MessageRow message={activity} connection={connection} />}
      {running && <ThinkingIndicator />}
      {conversation?.activeTurn?.wait && <section className="ponder-desktop-attention">
        <strong>{conversation.activeTurn.wait.title}</strong>
        {conversation.activeTurn.wait.kind === "approval"
          ? <>
              <button type="button" onClick={() => void resolveWait(conversation.activeTurn!, { decision: "accepted" })}>Approve</button>
              <button type="button" onClick={() => void resolveWait(conversation.activeTurn!, { decision: "declined" })}>Decline</button>
            </>
          : conversation.activeTurn.wait.options.length > 0
            ? conversation.activeTurn.wait.options.map((option) => <button key={option} type="button"
                onClick={() => void resolveWait(conversation.activeTurn!, { value: option })}>{option}</button>)
            : <form onSubmit={(event) => { event.preventDefault(); void resolveWait(conversation.activeTurn!, { value: waitResponse }); }}>
                <input aria-label="Response to Ponder Pal" value={waitResponse} onChange={(event) => setWaitResponse(event.target.value)} />
                <button type="submit" disabled={!waitResponse.trim()}>Send response</button>
              </form>}
      </section>}
      {conversation?.activeTurn?.outputs?.map((output) => output.downloadURL
        ? <a key={output.id} href={output.downloadURL} target="_blank" rel="noreferrer">{output.name}</a>
        : <button key={output.id} type="button" onClick={() => void openOutput(output.id)}>{output.name}</button>)}
      {error && <MessageRow message={{ id: "ponder-error", role: "error", content: error,
        timestamp: new Date().toISOString() }} connection={connection} />}
    </section>
    <div className="composer-stack dock">
      <PonderLocalMessageControl sessions={sessions} state={localMessage} onSelect={chooseLocalTarget} />
      {editingRecommendation ? <div className="ponder-message-destination" role="status">
        <span>Message to {editingRecommendation.target.title}</span><button type="button" onClick={returnToChat}>Return to Ponder chat</button>
      </div> : null}
      <Composer {...composer} experience="chat" mode="dock" showProjectFooter={false} hideModelControls
        connection={connection} prompt={draft} onPromptChange={setDraft}
        busy={sending || Boolean(recommendations.busy) || localMessage.busy || !binding || Boolean(localMessage.sessionId && (!localMessage.target?.canSendFollowup || localMessage.changed))}
        running={running && !editingRecommendation && !localMessage.sessionId} submissionScopeKey={`ponder:${binding?.conversationId ?? "loading"}:${localMessage.sessionId ?? editingRecommendation?.id ?? "chat"}`}
        voiceInputChannelKey={`ponder:${binding?.conversationId ?? "loading"}`}
        onSubmit={(attachments, _action, _command, options) => send(attachments,
          options?.promptOverride ? { promptOverride: options.promptOverride } : undefined)}
        onStop={() => conversation?.activeTurn ? stop(conversation.activeTurn) : undefined} />
    </div>
  </div>;
}
