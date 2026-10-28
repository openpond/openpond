import { useEffect, useRef, useState } from "react";
import type { CodexRecoveryRequest, CodexRecoveryResponse } from "@openpond/contracts";
import type { ClientConnection } from "../../api/api-client";
import { sessionApi } from "../../api/session-api";
import { useAppToast, useErrorToast } from "../../app/AppToastContext";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import { ArrowUpRight, ExternalLink } from "../icons";
import "./codex-ownership-recovery.css";

type Recover = (
  connection: ClientConnection,
  sessionId: string,
  request: CodexRecoveryRequest,
) => Promise<CodexRecoveryResponse>;

export function CodexOwnershipRecovery({
  connection,
  sessionId,
  failedTurnId,
  recover = sessionApi.recoverCodex,
}: {
  connection: ClientConnection;
  sessionId: string;
  failedTurnId: string;
  recover?: Recover;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CodexRecoveryResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  const showToast = useAppToast();
  const { confirmAction, confirmDialog, resolveConfirmDialog } = useConfirmDialog();
  useErrorToast(error);
  useEffect(() => {
    generation.current++;
    locked.current = false;
    setBusy(false);
    setResult(null);
    setError(null);
    return () => {
      generation.current++;
      resolveConfirmDialog(false);
    };
  }, [connection, sessionId, failedTurnId, resolveConfirmDialog]);

  async function resume() {
    if (locked.current) return;
    const current = generation.current;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      let next = await recover(connection, sessionId, { failedTurnId });
      if (current !== generation.current) return;
      if (next.state === "active") {
        const expected = next.activeTurnId;
        const confirmed = await confirmAction({
          title: "Stop the current turn?",
          body: "This chat is running in OpenPond. Stop that turn before retrying the saved message? Review completed tool activity before continuing.",
          confirmLabel: "Stop and resume",
          tone: "danger",
        });
        if (!confirmed || current !== generation.current) return;
        next = await recover(connection, sessionId, {
          failedTurnId,
          confirmedActiveTurnId: expected,
        });
        if (current !== generation.current) return;
        if (next.state === "active") {
          showToast?.(
            "The active turn changed. Nothing else was stopped; retry to review the current turn.",
            "info",
          );
          return;
        }
      }
      setResult(next);
      if (next.state === "external")
        showToast?.(
          "Open this chat in Codex and archive it to release its writer. Then return here and choose Retry; OpenPond will restore the same thread.",
          "info",
        );
      if (next.state === "resumed")
        showToast?.("Saved message queued to resume in OpenPond.", "success");
      if (next.state === "superseded")
        showToast?.(
          "This saved message changed or the chat has moved on. Use the current composer or queue to continue.",
          "info",
        );
    } catch (cause) {
      if (current === generation.current) setError(cause);
    } finally {
      if (current === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  const resolved = result?.state === "resumed" || result?.state === "superseded";
  const threadId = result?.state === "external" ? result.threadId : null;
  const codexUrl = threadId ? `codex://threads/${encodeURIComponent(threadId)}` : null;
  return (
    <>
      {!resolved ? (
        <div
          className="codex-ownership-actions"
          aria-label="Chat ownership recovery"
          aria-busy={busy}
        >
          <button
            type="button"
            className="composer-steer-row-action primary"
            disabled={busy}
            onClick={() => void resume()}
          >
            <ArrowUpRight size={12} aria-hidden />
            <span>{busy ? "Checking ownership…" : threadId ? "Retry" : "Resume in OpenPond"}</span>
          </button>
          {codexUrl ? (
            <a
              className="composer-steer-row-action"
              href={codexUrl}
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) {
                  event.preventDefault();
                  return;
                }
                if (window.openpond?.openCodexThread) {
                  event.preventDefault();
                  const current = generation.current;
                  void window.openpond.openCodexThread({ threadId: threadId! }).catch((cause) => {
                    if (current === generation.current) setError(cause);
                  });
                }
              }}
            >
              <ExternalLink size={12} aria-hidden />
              <span>Open in Codex</span>
            </a>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog state={confirmDialog} onResolve={resolveConfirmDialog} />
    </>
  );
}
