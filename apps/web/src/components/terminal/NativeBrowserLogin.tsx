import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { ClientConnection } from "../../api/api-client";
import { useAppToast, useErrorToast } from "../../app/AppToastContext";
import { AppDialog } from "../dialogs/AppDialog";
import { Copy, ExternalLink, Loader2, SquareTerminal, X } from "../icons";
import type { TerminalTab } from "./terminal-overlay-types";
import { nativeLoginCodeInput, readNativeLoginOutput } from "./native-login-output";
import "../../styles/workspace/git-dialogs.css";
import "./native-setup-terminal.css";
import "./native-browser-login.css";

const TerminalOverlay = lazy(() => import("./TerminalOverlay").then(module => ({ default: module.TerminalOverlay })));
type LoginProps = { connection: ClientConnection; command: string; displayCommand?: string; onClose(): void; onComplete?(): void; openRequest?: number };

export function NativeBrowserLogin(props: LoginProps) {
  const [attempt, setAttempt] = useState(0);
  return <NativeBrowserLoginAttempt key={attempt} {...props} onRetry={() => setAttempt(current => current + 1)} />;
}

function NativeBrowserLoginAttempt({ connection, command, displayCommand = "claude auth login", onClose, onComplete, openRequest, onRetry }: LoginProps & { onRetry(): void }) {
  const [mode, setMode] = useState<"dialog" | "terminal" | "minimized">("dialog");
  useEffect(() => { setMode("dialog"); }, [openRequest]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [scope] = useState(() => ({ kind: "draft" as const, id: `native-login-${crypto.randomUUID()}` }));
  const [setupCommand] = useState(() => ({ command, displayCommand }));
  const [handoff, setHandoff] = useState<ReturnType<typeof readNativeLoginOutput>>({ url: null, needsCode: false, needsEnter: false });
  const [setupInput, setSetupInput] = useState<{ id: number; data: string }>();
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error, { prefix: "Claude sign-in" });
  const showToast = useAppToast();
  const output = useRef("");
  const inputSequence = useRef(0);
  const continued = useRef(false);
  const completed = useRef(false);
  const failed = tabs.some(tab => tab.commandStatus === "failed" || tab.status === "error");
  const failedExit = tabs.some(tab => tab.status === "exited" && tab.lastExitCode !== 0);
  const running = !failed && !tabs.some(tab => tab.status === "exited");

  const receiveOutput = useCallback((data: string) => {
    output.current = (output.current + data).slice(-64 * 1024);
    const next = readNativeLoginOutput(output.current);
    setHandoff(current => current.url === next.url && current.needsCode === next.needsCode && current.needsEnter === next.needsEnter ? current : next);
  }, []);

  useEffect(() => {
    if (handoff.needsEnter && !continued.current && running) {
      continued.current = true;
      setSetupInput({ id: ++inputSequence.current, data: "\r" });
    }
  }, [handoff.needsEnter, running]);

  useEffect(() => {
    if (!completed.current && tabs.some(tab => tab.commandStatus === "success" && tab.lastExitCode === 0)) {
      completed.current = true;
      (onComplete ?? onClose)();
    }
  }, [onClose, onComplete, tabs]);

  useEffect(() => {
    if (failedExit) setError("Sign-in did not complete. Try again or open the terminal for details.");
  }, [failedExit]);

  async function openBrowser() {
    if (!handoff.url || !running) return;
    try {
      const browser = window.openpond?.browser;
      if (browser?.openExternal) {
        const result = await browser.openExternal({ conversationId: scope.id, url: handoff.url });
        if (!result.ok) throw new Error(result.error ?? "Could not open your browser.");
      } else {
        const opened = window.open(handoff.url, "_blank", "noopener,noreferrer");
        // noopener can return null even when navigation succeeded.
        opened?.focus();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function copyLink() {
    if (!handoff.url || !running) return;
    try {
      await navigator.clipboard.writeText(handoff.url);
      showToast?.("Sign-in link copied.", "success");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not copy the sign-in link."); }
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();
    const data = nativeLoginCodeInput(code);
    if (!data) { setError("Paste the code from your browser as a single line."); return; }
    if (!running || !handoff.needsCode || submitted) return;
    setError(null);
    setSetupInput({ id: ++inputSequence.current, data });
    setCode("");
    setSubmitted(true);
  }

  return createPortal(<div className="native-login-session">
    <div className="native-login-status">
      <button type="button" className="native-login-resume" onClick={() => setMode("dialog")}>
        {running ? <Loader2 size={15} className="native-login-spin" /> : <img src="/agent-sources/claude-code.svg" alt="" />}
        <span>Claude sign-in</span>
      </button>
      <button type="button" onClick={() => setMode(mode === "terminal" ? "minimized" : "terminal")} aria-expanded={mode === "terminal"}><SquareTerminal size={15} /> {mode === "terminal" ? "Hide terminal" : "Show terminal"}</button>
      <button type="button" aria-label="Cancel Claude sign-in" onClick={onClose}><X size={15} /></button>
    </div>
    <div className={`native-setup-terminal native-login-terminal ${mode === "terminal" ? "expanded" : ""}`}>
      <Suspense fallback={null}><TerminalOverlay open={mode === "terminal"} background disposeOnUnmount connection={connection} scope={scope} tabs={tabs} onTabsChange={setTabs} cwd={null} appId={null} workspaceName="Claude sign-in" queuedCommand={null} setupCommand={setupCommand} setupInput={setupInput} onOutput={receiveOutput} onClose={() => setMode("minimized")} /></Suspense>
    </div>
    {mode === "dialog" ? <AppDialog ariaLabel="Sign in to Claude" backdropClassName="git-dialog-backdrop native-login-backdrop" className="git-dialog native-login-dialog" onClose={() => setMode("minimized")}>
      <button type="button" className="git-dialog-close" aria-label="Minimize Claude sign-in" onClick={() => setMode("minimized")}><X size={16} /></button>
      <img className="native-login-icon" src="/agent-sources/claude-code.svg" alt="" />
      <h2>Sign in to Claude</h2>
      <p>Finish signing in through your browser. This window will close when you’re connected.</p>
      {running ? <>
        <div className="native-login-actions">
          <button type="button" className="git-dialog-primary" disabled={!handoff.url} onClick={() => void openBrowser()}><ExternalLink size={15} /> Continue in browser</button>
          <button type="button" className="native-login-secondary" disabled={!handoff.url} onClick={() => void copyLink()}><Copy size={15} /> Copy link</button>
        </div>
        <p className="native-login-progress" role="status"><Loader2 size={14} className="native-login-spin" /> {submitted ? "Completing sign-in…" : handoff.url ? "Waiting for browser sign-in…" : "Preparing your sign-in link…"}</p>
        {handoff.needsCode ? <form onSubmit={submitCode} className="native-login-code">
          <label className="git-dialog-field"><span>If your browser gave you a code</span><input type="password" autoComplete="off" spellCheck={false} aria-label="Claude sign-in code" value={code} disabled={submitted} onChange={event => setCode(event.target.value)} placeholder="Paste the code" /></label>
          <button type="submit" className="native-login-secondary" disabled={submitted || !code.trim()}>Submit code</button>
        </form> : null}
      </> : <button type="button" className="git-dialog-primary" onClick={onRetry}>Try again</button>}
      <footer><button type="button" onClick={() => setMode("terminal")}><SquareTerminal size={14} /> Terminal details</button><button type="button" onClick={onClose}>Cancel sign-in</button></footer>
    </AppDialog> : null}
  </div>, document.body);
}
