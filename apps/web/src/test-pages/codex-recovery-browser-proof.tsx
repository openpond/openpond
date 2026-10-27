import { useCallback, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CodexRecoveryResponse } from "@openpond/contracts";
import { CodexOwnershipRecovery } from "../components/chat/CodexOwnershipRecovery";
import { ComposerSteerRow } from "../components/chat/ComposerSteerRow";
import { AppToastProvider } from "../app/AppToastContext";
import { AppToast } from "../components/app-shell/AppToast";
import { appReducer, initialAppState, type ShowAppToast } from "../app/app-state";
import { useToastPresentation } from "../hooks/useToastPresentation";
import "../styles/theme.css";
import "../styles.css";

// Synthetic, development-only proof of the production controls. No provider
// request, thread interruption or model turn is sent from this page.
const connection = { serverUrl: "http://proof.invalid", token: "synthetic", platform: "web" };
const modes =
  window.location.hash === "#external"
    ? (["external"] as const)
    : (["external", "active", "ready"] as const);
function Proof() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [resumed, setResumed] = useState(0);
  const [reset, setReset] = useState(0);
  const counter = useRef(0);
  const showToast = useCallback<ShowAppToast>((message, tone = "info", options = {}) => {
    const id = ++counter.current;
    dispatch({
      type: "showToast",
      toast: { id, createdAt: Date.now(), message, tone, ...options },
    });
    return id;
  }, []);
  const dismiss = useCallback((toastId: number) => dispatch({ type: "clearToast", toastId }), []);
  const presentation = useToastPresentation(state.toasts, dismiss, "recovery-proof");
  return (
    <AppToastProvider showToast={showToast}>
      <div className="app-shell sidebar-closed">
        <div className="content-shell">
          <div className="topbar" style={{ padding: "0 24px" }}>
            Chat ownership recovery
          </div>
          <main
            className="main-pane"
            style={{ display: "block", overflow: "auto", padding: "32px 24px" }}
          >
            <div style={{ maxWidth: 780, margin: "0 auto" }}>
              <div className="message-row user">
                <div className="user-message">Review the model and runs sidebar with me.</div>
              </div>
              {modes.map((mode) => (
                <section
                  key={`${reset}:${mode}`}
                  style={{ marginTop: 32 }}
                  aria-label={`${mode} writer scenario`}
                >
                  <div className="message-row assistant">
                    <div className="assistant-message error-message">
                      Another Codex session owns this chat. Your message is saved here for retry.
                      <CodexOwnershipRecovery
                        connection={connection}
                        sessionId={mode}
                        failedTurnId={`failed-${mode}`}
                        recover={async (
                          _connection,
                          _session,
                          request,
                        ): Promise<CodexRecoveryResponse> => {
                          if (mode === "external")
                            return {
                              state: "external",
                              threadId: "00000000-0000-4000-8000-000000000001",
                            };
                          if (mode === "active" && !request.confirmedActiveTurnId)
                            return { state: "active", activeTurnId: "live-turn" };
                          setResumed((value) => value + 1);
                          return { state: "resumed" };
                        }}
                      />
                    </div>
                  </div>
                </section>
              ))}
              <div style={{ marginTop: 32 }}>
                <ComposerSteerRow
                  prompt="Review the model and runs sidebar with me."
                  actionLabel="Resume"
                  onSend={() => {}}
                  onEdit={() => {}}
                  onDelete={() => {}}
                />
              </div>
              <div style={{ marginTop: 24, display: "flex", gap: 12, alignItems: "center" }}>
                <output>Requests resumed: {resumed}</output>
                <button
                  type="button"
                  className="composer-steer-row-action"
                  onClick={() => setReset((value) => value + 1)}
                >
                  Reset scenarios
                </button>
              </div>
            </div>
          </main>
          <div className="app-toast-anchor">
            <AppToast {...presentation} />
          </div>
        </div>
      </div>
    </AppToastProvider>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Proof />);
import.meta.hot?.dispose(() => root.unmount());
