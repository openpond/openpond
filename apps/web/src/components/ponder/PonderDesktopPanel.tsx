import { useEffect, useMemo, useRef, useState } from "react";
import { type Session, type ChatAttachment } from "@openpond/contracts";
import { ApiRequestError, apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import type { ChatMessage } from "../../lib/app-models";
import { Composer, type ComposerProps } from "../chat/Composer";
import { ThinkingIndicator } from "../chat/Messages";
import { ChatActivitySummary } from "../chat/ChatActivitySummary";
import { useMainPaneChatScroll } from "../app-shell/useMainPaneChatScroll";
import { MessageNavigationControls } from "../app-shell/MainPaneControls";
import { PonderRecommendations } from "./PonderRecommendations";
import { usePonderRecommendations } from "./usePonderRecommendations";
import { hostedRecommendationSendBlocked, type PonderRecommendation } from "./ponder-recommendations";
import { PonderResultAttention } from "./PonderResultAttention";
import { PonderTranscriptMessage, type PonderConversationMessage } from "./PonderTranscriptMessage";
import { assertOriginalPonderDesktop, type PonderLinkedLocalWork } from "./ponder-local-work";
import { usePonderWork } from "./usePonderWork";
import { PonderAgentActivity } from "./PonderAgentActivity";
import { downloadPonderLocalOutput, type PonderLocalOutputSource } from "./ponder-local-output";

type Binding = { bindingId: string; conversationId: string; introductionSeenVersion: number };
type Turn = { id: string; status: string; errorCode?: string | null; errorText?: string | null; lastSequence: number; wait?: { id: string; kind: string; title: string; options: string[] } | null;
  outputs?: Array<{ id: string; name: string; downloadURL?: string | null }> };
type Conversation = { id: string; messages: PonderConversationMessage[]; activeTurn: Turn | null };
type InputRef = { id: string; name: string; contentType: string; sizeBytes: number };
type Upload = { input: InputRef; upload: { url: string; method: string; headers: Record<string, string> } };

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
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/<(?:!doctype|html|head|body)\b/i.test(message) || /\b50[234]\b/.test(message)) {
    return "Ponder Pal is temporarily unavailable. Please try again.";
  }
  return message.length > 240 ? "Ponder Pal couldn’t complete this action. Please try again." : message;
}

export function PonderDesktopPanel({ connection, accountScopeKey, localSessions, composer, onOpenWork, onOpenLocalWork }: {
  connection: ClientConnection;
  accountScopeKey: string;
  presentation: "clean" | "activity";
  localSessions: Session[];
  composer: SharedComposerProps;
  onOpenWork: (conversationId: string) => void;
  onOpenLocalWork: (sessionId: string) => void;
}) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [waitResponse, setWaitResponse] = useState("");
  const [sending, setSending] = useState(false);
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error ? displayError(error) : null);
  const work = usePonderWork(connection, Boolean(binding), accountScopeKey, false);
  const linkedWork = work.data?.items ?? [];
  const localWork = work.data?.localItems ?? [];
  const localHandoffs = work.data?.localHandoffs ?? [];
  const recommendations = usePonderRecommendations(connection, binding?.bindingId ?? null);
  useErrorToast(recommendations.error ? displayError(recommendations.error) : null);
  useErrorToast(conversation?.activeTurn?.status === "failed"
    ? displayError(conversation.activeTurn.errorText ?? "Ponder couldn’t complete this request. Please try again.")
    : null);
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
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await apiFetch<Conversation>(connection, `/v1/ponder/conversations/${encodeURIComponent(binding.conversationId)}`);
        if (active) setConversation(value);
      } catch (cause) { if (active) setError(displayError(cause)); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [connection, binding]);

  useEffect(() => { if (work.error) setError(displayError(work.error)); }, [work.error]);

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
      setSubmissionVersion(version => version + 1);
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

  const running = Boolean(conversation?.activeTurn && ["queued", "running", "retry_scheduled"].includes(conversation.activeTurn.status));
  const discussionActive = Boolean(conversation?.activeTurn && ["queued", "running", "retry_scheduled", "waiting_approval", "waiting_input"].includes(conversation.activeTurn.status));
  const latestAssistantId = conversation?.messages.reduce<string | undefined>((latest, message) =>
    message.role === "assistant" && !message.metadata.ponderMessage && !message.metadata.ponderLocalMessage
      && message.text.trim() ? message.id : latest, undefined);
  const agentSources = <PonderAgentActivity items={localWork} workflow={localHandoffs[0]} sessions={localSessions}
    onOpenTask={item => void openLocalWork(item)} />;
  const scrollMessages = useMemo<ChatMessage[]>(() => (conversation?.messages ?? []).map(message => ({
    id: message.id, role: message.role === "user" ? "user" : "assistant",
    content: message.text, timestamp: message.createdAt,
  })), [conversation?.messages]);
  const scroll = useMainPaneChatScroll({
    browserConversationId: conversation?.id ?? null, chatSubmissionVersion: submissionVersion,
    chatMessages: scrollMessages, chatHistoryHasMore: false, chatHistoryLoading: false,
    pendingApproval: null, showChatThread: true, showThinkingIndicator: running, view: "chat",
  });
  return <div className="chat-column" aria-label="Ponder Pal" style={scroll.chatColumnStyle}>
    <section className="chat-thread" aria-label="Conversation" tabIndex={0}
      ref={scroll.chatThreadRef} onScroll={event => scroll.handleChatScroll(event.currentTarget)}>
      {!conversation && !error && <article className="activity-group thinking-row" role="status">
        <ChatActivitySummary running>Loading conversation…</ChatActivitySummary>
      </article>}
      <PonderResultAttention connection={connection} work={linkedWork} localWork={localWork} onOpenWork={onOpenWork}
        onOpenLocalWork={source => void openLocalWork(source)}
        onOpenLocalOutput={(source, outputId) => void openLocalOutput(source, outputId)} onOpenOutput={outputId => void openOutput(outputId)}
        busy={sending || discussionActive} />
      {conversation?.messages.map(message => <PonderTranscriptMessage key={message.id} message={message}
        agentSources={message.id === latestAssistantId ? agentSources : undefined}
        connection={connection} work={linkedWork} onOpenWork={onOpenWork} onOpenOutput={fileId => void openOutput(fileId)}
        onOpenLocalWork={source => void openLocalWork(source)} onOpenLocalOutput={(source, outputId) => void openLocalOutput(source, outputId)} />)}
      <PonderRecommendations items={recommendations.items} busy={recommendations.busy} editingId={editingRecommendation?.id ?? null}
        onEdit={editRecommendation}
        onSend={item => { void recommendationAction(item, "send"); }}
        onDismiss={item => { void recommendationAction(item, "dismiss"); }}
        onOpen={onOpenWork} />
      {!latestAssistantId ? agentSources : null}
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
    </section>
    <div className="composer-stack dock" ref={scroll.composerStackRef}>
      {scroll.showScrollToBottomButton && !scroll.chatThreadPreparingInitialScroll && <MessageNavigationControls
        canGoNext={scroll.userMessageNavigation.canGoNext} canGoPrevious={scroll.userMessageNavigation.canGoPrevious}
        onJumpToLatest={scroll.jumpToLatestChatMessage}
        onNext={() => scroll.userMessageNavigation.canGoNext && scroll.goToUserMessage("next")}
        onPrevious={() => scroll.userMessageNavigation.canGoPrevious && scroll.goToUserMessage("previous")} />}
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
