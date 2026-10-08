import { useEffect, useRef, useState } from "react";
import { PonderDesktopHandoffPresentationSchema, type PonderDesktopHandoffPresentation, type ChatAttachment } from "@openpond/contracts";
import { ApiRequestError, apiFetch, type ClientConnection } from "../../api/api-client";
import type { ChatMessage } from "../../lib/app-models";
import { Composer, type ComposerProps } from "../chat/Composer";
import { MessageRow } from "../chat/Messages";
import { PonderRecommendations } from "./PonderRecommendations";
import { usePonderRecommendations } from "./usePonderRecommendations";
import { hostedRecommendationSendBlocked, type PonderRecommendation } from "./ponder-recommendations";
import { PonderResultAttention, type PonderLinkedWork } from "./PonderResultAttention";
import { PonderTranscriptMessage, type PonderConversationMessage } from "./PonderTranscriptMessage";
import { assertOriginalPonderDesktop, type PonderLinkedLocalWork } from "./ponder-local-work";
import { PonderHandoffActivity } from "./PonderHandoffActivity";
import { downloadPonderLocalOutput, type PonderLocalOutputSource } from "./ponder-local-output";

type Binding = { bindingId: string; conversationId: string; introductionSeenVersion: number };
type Turn = { id: string; status: string; errorCode?: string | null; errorText?: string | null; lastSequence: number; wait?: { id: string; kind: string; title: string; options: string[] } | null;
  outputs?: Array<{ id: string; name: string; downloadURL?: string | null }> };
type Conversation = { id: string; messages: PonderConversationMessage[]; activeTurn: Turn | null };
type TurnEvent = { id: string; sequence: number; type: string; text: string | null };
type InputRef = { id: string; name: string; contentType: string; sizeBytes: number };
type Upload = { input: InputRef; upload: { url: string; method: string; headers: Record<string, string> } };
type LinkedWork = PonderLinkedWork;

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

export function PonderDesktopPanel({ connection, presentation, composer, onOpenWork, onOpenLocalWork }: {
  connection: ClientConnection;
  presentation: "clean" | "activity";
  composer: SharedComposerProps;
  onOpenWork: (conversationId: string) => void;
  onOpenLocalWork: (sessionId: string) => void;
}) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [waitResponse, setWaitResponse] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<TurnEvent[]>([]);
  const [linkedWork, setLinkedWork] = useState<LinkedWork[]>([]);
  const [localWork, setLocalWork] = useState<PonderLinkedLocalWork[]>([]);
  const [localHandoffs, setLocalHandoffs] = useState<PonderDesktopHandoffPresentation[]>([]);
  const [cancellingHandoff, setCancellingHandoff] = useState<string | null>(null);
  const handoffControlKeys = useRef(new Map<string, string>());
  const activityCursor = useRef<string | null>(null);
  const recommendations = usePonderRecommendations(connection, binding?.bindingId ?? null);
  const [editingRecommendation, setEditingRecommendation] = useState<PonderRecommendation | null>(null);
  const currentEditingRecommendation = editingRecommendation ? recommendations.items.find(item => item.id === editingRecommendation.id) : null;
  const editingUnavailable = Boolean(editingRecommendation && (!currentEditingRecommendation || currentEditingRecommendation.state !== "proposed" || currentEditingRecommendation.revision !== editingRecommendation.revision || hostedRecommendationSendBlocked(currentEditingRecommendation)));
  const chatDraft = useRef("");
  const activeContext = useRef({ connection, bindingId: binding?.bindingId, destination: editingRecommendation?.id ?? "chat", draft });
  activeContext.current = { connection, bindingId: binding?.bindingId, destination: editingRecommendation?.id ?? "chat", draft };
  const submitting = useRef(false);
  const mounted = useRef(true);
  function returnToChat() {
    setEditingRecommendation(null);
    setDraft(chatDraft.current);
  }
  function editRecommendation(item: PonderRecommendation) {
    if (!editingRecommendation) chatDraft.current = draft;
    setEditingRecommendation(item);
    setDraft(item.proposedText ?? "");
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
    setLocalWork([]);
    setLocalHandoffs([]);
    setCancellingHandoff(null);
    handoffControlKeys.current.clear();
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
        const value = await apiFetch<{ items: LinkedWork[]; localItems: PonderLinkedLocalWork[]; localHandoffs: unknown }>(connection, "/v1/ponder/work");
        const handoffs = PonderDesktopHandoffPresentationSchema.array().parse(value.localHandoffs);
        if (active) { setLinkedWork(value.items); setLocalWork(value.localItems); setLocalHandoffs(handoffs); }
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
      if (editingRecommendation) {
        if (editingUnavailable) throw new Error("Review the latest task state before sending this proposed message.");
        if (attachments.length) throw new Error("Send task messages as text. Attachments can be sent in the task's own conversation.");
        const sent = await recommendations.action(editingRecommendation, "send", prompt);
        if (!stillCurrent()) return false;
        if (sent && activeContext.current.draft === context.draft) {
          returnToChat();
        }
        return sent;
      }
      const inputs = await Promise.all(attachments.map(uploadAttachment));
      if (!stillCurrent()) return false;
      const admitted = await apiFetch<Turn>(connection, `/v1/ponder/conversations/${encodeURIComponent(binding.conversationId)}/turns`, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ prompt, attachments: inputs }),
      });
      if (!stillCurrent()) return false;
      setConversation(current => current ? { ...current, activeTurn: admitted } : { id: binding.conversationId, messages: [], activeTurn: admitted });
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

  async function openLocalWork(source: Pick<PonderLinkedLocalWork, "sessionId" | "installationId" | "profileId" | "ownerUserId" | "teamId">) {
    if (!source.sessionId) return;
    const context = activeContext.current;
    const current = () => mounted.current && activeContext.current.connection === context.connection
      && activeContext.current.bindingId === context.bindingId;
    try {
      await assertOriginalPonderDesktop(connection, source);
      if (!current()) return;
      onOpenLocalWork(source.sessionId);
    } catch (cause) { if (current()) setError(displayError(cause)); }
  }

  async function openLocalOutput(source: PonderLocalOutputSource, outputId: string) {
    const context = activeContext.current;
    const current = () => mounted.current && activeContext.current.connection === context.connection
      && activeContext.current.bindingId === context.bindingId;
    try { await downloadPonderLocalOutput(connection, source, outputId, current); }
    catch (cause) { if (current()) setError(displayError(cause)); }
  }

  async function cancelHandoff(item: PonderDesktopHandoffPresentation) {
    if (cancellingHandoff) return;
    const context = activeContext.current;
    const current = () => mounted.current && activeContext.current.connection === context.connection && activeContext.current.bindingId === context.bindingId;
    const key = `${item.id}:${item.revision}`;
    if (!handoffControlKeys.current.has(key)) handoffControlKeys.current.set(key, crypto.randomUUID());
    setCancellingHandoff(item.id);
    try {
      await apiFetch(connection, "/v1/ponder/handoffs/cancel", { method: "POST", headers: { "Idempotency-Key": handoffControlKeys.current.get(key)! },
        body: JSON.stringify({ handoffId: item.id, expectedRevision: item.revision }) });
      const value = await apiFetch<{ localHandoffs: unknown }>(connection, "/v1/ponder/work");
      const handoffs = PonderDesktopHandoffPresentationSchema.array().parse(value.localHandoffs);
      if (current()) { setLocalHandoffs(handoffs); setError(null); }
    } catch (cause) { if (current()) setError(displayError(cause)); }
    finally { if (current()) setCancellingHandoff(null); }
  }

  const running = Boolean(conversation?.activeTurn && ["queued", "running", "retry_scheduled"].includes(conversation.activeTurn.status));
  const discussionActive = Boolean(conversation?.activeTurn && ["queued", "running", "retry_scheduled", "waiting_approval", "waiting_input"].includes(conversation.activeTurn.status));
  const activity: ChatMessage | null = presentation === "activity" && events.length > 0
    ? { id: "ponder-activity", role: "activity_group", timestamp: new Date().toISOString(),
      activities: events.map((event) => ({ id: event.id, label: event.type,
        content: event.text ?? "", timestamp: new Date().toISOString() })) }
    : null;

  return <div className="chat-column" aria-label="Ponder Pal">
    <section className="chat-thread" aria-label="Conversation">
      <PonderHandoffActivity connection={connection} items={localHandoffs} onEdited={async () => {
        const context = activeContext.current;
        const value = await apiFetch<{ localHandoffs: unknown }>(connection, "/v1/ponder/work");
        if (mounted.current && activeContext.current.connection === context.connection && activeContext.current.bindingId === context.bindingId)
          setLocalHandoffs(PonderDesktopHandoffPresentationSchema.array().parse(value.localHandoffs));
      }} onOpenTask={(item, sessionId) => void openLocalWork({ ...item.scope, sessionId })}
        onCancel={item => void cancelHandoff(item)} cancelling={cancellingHandoff} />
      <PonderResultAttention connection={connection} work={linkedWork} localWork={localWork} onOpenWork={onOpenWork}
        onOpenLocalWork={source => void openLocalWork(source)}
        onOpenLocalOutput={(source, outputId) => void openLocalOutput(source, outputId)} onOpenOutput={outputId => void openOutput(outputId)}
        busy={sending || discussionActive} />
      {conversation?.messages.map(message => <PonderTranscriptMessage key={message.id} message={message}
        connection={connection} work={linkedWork} onOpenWork={onOpenWork} onOpenOutput={fileId => void openOutput(fileId)}
        onOpenLocalWork={source => void openLocalWork(source)} onOpenLocalOutput={(source, outputId) => void openLocalOutput(source, outputId)} />)}
      <PonderRecommendations items={recommendations.items} busy={recommendations.busy} editingId={editingRecommendation?.id ?? null}
        onEdit={editRecommendation}
        onSend={item => { void recommendationAction(item, "send"); }}
        onDismiss={item => { void recommendationAction(item, "dismiss"); }}
        onOpen={onOpenWork} />
      {recommendations.error ? <p role="alert">{recommendations.error}</p> : null}
      {activity && <MessageRow message={activity} connection={connection} />}
      {running && <p className="ponder-request-status" role="status" aria-live="polite">
        Request received. Ponder is working on it…
      </p>}
      {conversation?.activeTurn?.status === "failed" && <p className="ponder-request-status" role="alert">
        Ponder couldn’t complete this request. {conversation.activeTurn.errorText ?? "Please try again."}
      </p>}
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
      {editingRecommendation ? <div className="ponder-message-destination" role="status">
        <span>Message to {editingRecommendation.target.title}{editingUnavailable ? " — review the latest task state before sending" : ""}</span><button type="button" onClick={returnToChat}>Return to Ponder chat</button>
      </div> : null}
      <Composer {...composer} experience="chat" mode="dock" showProjectFooter={false} hideModelControls
        connection={connection} prompt={draft} onPromptChange={setDraft}
        busy={sending || editingUnavailable || Boolean(recommendations.busy) || !binding}
        running={running && !editingRecommendation} submissionScopeKey={`ponder:${binding?.conversationId ?? "loading"}:${editingRecommendation?.id ?? "chat"}`}
        voiceInputChannelKey={`ponder:${binding?.conversationId ?? "loading"}`}
        onSubmit={(attachments, _action, _command, options) => send(attachments,
          options?.promptOverride ? { promptOverride: options.promptOverride } : undefined)}
        onStop={() => conversation?.activeTurn ? stop(conversation.activeTurn) : undefined} />
    </div>
  </div>;
}
