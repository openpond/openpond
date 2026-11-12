import { useRef, useState } from "react";
import type { ComposerProps } from "./composer-types";
import type { TaskInboxController } from "../../hooks/useTaskInbox";
import { useErrorToast } from "../../app/AppToastContext";
import { useDesktopCorrections } from "./DesktopCorrectionsContext";
import { modelsLocation, modelsPath } from "../labs/lab-primary-tab-state";
import "./desktop-log-issue.css";

export function DesktopLogIssueAction({ conversationId, inbox, running, onSubmit, showToast }: {
  conversationId: string | null;
  inbox: TaskInboxController;
  running: boolean;
} & Pick<ComposerProps, "onSubmit" | "showToast">) {
  const corrections = useDesktopCorrections();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef(false);
  const scope = `${corrections?.data?.scopeKey ?? ""}:${conversationId}`;
  const latestScope = useRef(scope); latestScope.current = scope;
  useErrorToast(error);
  useErrorToast(corrections?.error);
  useErrorToast(corrections?.data?.destinationError);
  if (!corrections) return null;
  const active = running || Boolean(inbox.snapshot?.activeTurnId);
  const canSteer = inbox.snapshot?.acceptingInput && Boolean(inbox.snapshot.activeTurnId);
  async function logIssue() {
    if (pending.current) { showToast("The issue logging request is already being sent.", "info"); return; }
    if (!conversationId) { showToast("Start a conversation first, then log the issue.", "info"); return; }
    if (!corrections?.data?.dataset) {
      if (corrections?.error) setError(corrections.error);
      else showToast(corrections?.unavailableReason ?? "Choose an available issue dataset in Settings.", "info");
      return;
    }
    if (inbox.busyId) { showToast("Another message is being sent. Try again in a moment.", "info"); return; }
    if (active && !canSteer) { showToast("This response is not accepting steering yet. Try again in a moment.", "info"); return; }
    pending.current = true; setSending(true); setError(null);
    const origin = scope;
    try {
      const dataset = corrections.data.dataset;
      const path = modelsPath(modelsLocation("datasets", null, { area: "console", resourceId: dataset.id, detailTab: "tasks", projectId: null, executionLocation: "hosted" }));
      const url = corrections.webBaseUrl ? new URL(path, corrections.webBaseUrl).href : null;
      const destination = url ? `[${dataset.name.replace(/[\\[\]]/g, "\\$&")}](${url})` : dataset.name;
      const prompt = `Review the latest issue and add a task to my ${destination} dataset (ID: ${dataset.id}). Include what went wrong, the expected behavior, and relevant context. After this is done, continue with what you were currently working on.`;
      // Historical chats have no task inbox; normal submission resumes the selected chat.
      // Both paths leave the draft and its attachments untouched.
      const accepted = active ? await inbox.steer(prompt) : await onSubmit([], null, null, { preservePrompt: true, promptOverride: prompt });
      if (accepted && latestScope.current === origin) showToast("Issue logging requested. The agent will confirm when the task is saved.", "info");
    } catch (cause) {
      if (latestScope.current === origin) setError(cause);
    } finally { pending.current = false; setSending(false); }
  }
  return <div className="desktop-log-issue">
    <button type="button" aria-busy={sending} onClick={() => void logIssue()}
      title={!conversationId ? "Start a conversation before logging an issue" : corrections.unavailableReason
        ?? (!corrections.data?.dataset ? "Choose an available issue dataset in Settings" : active && !canSteer ? "Waiting for the conversation to accept steering" : `Add the latest issue to ${corrections.data.dataset.name}`)}>
      {sending ? "Sending…" : "Log an issue"}
    </button>
    {corrections.error ? <button type="button" onClick={() => void corrections.refresh()}>Retry</button> : null}
  </div>;
}
