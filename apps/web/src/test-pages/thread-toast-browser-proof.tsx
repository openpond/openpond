import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { SessionSchema, SessionUserQuestionSchema, ApprovalSchema, type RuntimeEvent } from "@openpond/contracts";
import { AppToast } from "../components/app-shell/AppToast";
import { appReducer, initialAppState } from "../app/app-state";
import { useToastPresentation } from "../hooks/useToastPresentation";
import { useThreadNotifications } from "../hooks/useThreadNotifications";
import { useThreadNotificationReveal, requestThreadNotificationReveal } from "../hooks/useThreadNotificationReveal";
import { buildRuntimeIndexes } from "../lib/runtime-indexes";
import { RuntimeEventStore } from "../lib/runtime-event-store";
import type { ShowAppToast, ThreadToastTarget } from "../lib/app-toasts";
import { navigateDesktopRoute, registerDesktopNavigationGuard } from "../components/labs/lab-primary-tab-state";
import "../styles.css";

// Development-only proof using the production store, projection, reducer, host
// and navigation guard. All events are synthetic; this page calls no server API.
const session = SessionSchema.parse({ id: "proof-background", provider: "openpond", title: "Review the deployment plan", appId: null,
  appName: null, cwd: null, codexThreadId: null, createdAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-10T10:00:00Z",
  status: "idle", pinned: false, archived: false, order: 0 });
const sessions = [session];

export function ThreadToastBrowserProof() {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [store] = useState(() => new RuntimeEventStore());
  const events = useSyncExternalStore(store.subscribeSummary, store.getSummaryEvents);
  const indexes = useMemo(() => buildRuntimeIndexes(events, events.flatMap(event => {
    if (event.name !== "approval.requested") return [];
    const parsed = ApprovalSchema.safeParse(event.data);
    return parsed.success && !events.some(resolved => resolved.name === "approval.resolved" && (resolved.data as { approvalId?: string })?.approvalId === parsed.data.id) ? [parsed.data] : [];
  })), [events]);
  const [scope, setScope] = useState("proof-a");
  const currentScope = useRef(scope); currentScope.current = scope;
  const [selected, setSelected] = useState<string | null>(null);
  const [reject, setReject] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [opened, setOpened] = useState(0);
  const counter = useRef(0);
  const showToast = useCallback<ShowAppToast>((message, tone = "info", options = {}) => {
    const id = ++counter.current;
    dispatch({ type: "showToast", toast: { id, createdAt: Date.now(), message, tone, ...options } });
    return id;
  }, []);
  const dismiss = useCallback((toastId: number) => dispatch({ type: "clearToast", toastId }), []);
  const presentation = useToastPresentation(state.toasts, dismiss, scope);
  useThreadNotificationReveal(scope);
  useEffect(() => registerDesktopNavigationGuard(() => !reject), [reject]);
  const visible = useMemo(() => new Set(selected ? [selected] : []), [selected]);
  const openThread = useCallback(async (target: ThreadToastTarget, isCurrent: () => boolean) => {
    if (!await navigateDesktopRoute({ kind: "chat", sessionId: target.sessionId }, "push", () => currentScope.current === scope && isCurrent())) return false;
    setSelected(target.sessionId); setOpened(value => value + 1); requestThreadNotificationReveal(target); return true;
  }, [scope]);
  useThreadNotifications({ scope, afterSequence: 0, store, indexes, sessions, visibleSessionIds: visible,
    toasts: state.toasts, showToast, dispatch, openThread });
  function emit(name: RuntimeEvent["name"], data?: unknown) {
    const sequence = ++counter.current;
    store.appendLive([{ id: `proof-event-${sequence}`, sequence, name, sessionId: session.id, turnId: `proof-turn-${sequence}`,
      timestamp: new Date().toISOString(), data }]);
  }
  function complete() {
    setSelected(null);
    const sequence = ++counter.current;
    store.appendLive([
      { id: `proof-start-${sequence}`, sequence, name: "turn.started", sessionId: session.id, turnId: `proof-turn-${sequence}`, timestamp: new Date().toISOString() },
      { id: `proof-complete-${sequence}`, sequence: ++counter.current, name: "turn.completed", sessionId: session.id, turnId: `proof-turn-${sequence}`, timestamp: new Date().toISOString() },
    ]);
  }
  function ask() {
    setSelected(null);
    const id = `question-${counter.current + 1}`;
    const question = SessionUserQuestionSchema.parse({ id, sessionId: session.id, turnId: `proof-turn-${counter.current + 1}`,
      toolCallId: id, question: "Which environment should I use?", status: "pending", answer: null, createdAt: new Date().toISOString(), answeredAt: null });
    emit("user_question.asked", { question });
  }
  function approve() {
    setSelected(null);
    emit("approval.requested", ApprovalSchema.parse({ id: `approval-${counter.current + 1}`, sessionId: session.id, turnId: null,
      kind: "user_input", title: "Choose an environment", detail: "", providerRequestId: "native-agent:proof", status: "pending", createdAt: new Date().toISOString() }));
  }
  return <div className={`app-shell ${sidebar ? "sidebar-open" : "sidebar-closed"}`} style={{ "--sidebar-width": sidebar ? "260px" : "0px" } as React.CSSProperties}>
    <aside className="sidebar" inert={!sidebar}><div className="sidebar-toolbar"><strong>OpenPond</strong></div><div className="sidebar-scroll">
      <p style={{ padding: 12 }}>Synthetic local proof</p><p style={{ padding: 12 }}>Production notification components</p></div></aside>
    <div className="content-shell"><div className="topbar" style={{ padding: 12 }}>Thread notification proof</div>
      <main className="main-pane" tabIndex={-1} data-thread-session={selected ?? undefined} style={{ display: "block", padding: 28 }}>
        <h1>{selected ? session.title : "Workspace"}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "20px 0", maxWidth: 480 }}>
          <button onClick={complete}>Complete background thread</button><button onClick={ask}>Ask question</button><button onClick={approve}>Request input</button>
          <button onClick={() => showToast(`Notification ${counter.current + 1}`)}>Add toast</button>
          <button onClick={() => { for (let index = 0; index < 4; index++) showToast(`Burst ${index + 1}`); }}>Add four toasts</button>
          <button onClick={() => { setScope(value => value === "proof-a" ? "proof-b" : "proof-a"); setSelected(null); store.clear(); }}>Switch scope</button>
          <button onClick={() => setSidebar(value => !value)}>Toggle sidebar</button>
          <button onClick={() => setDialog(true)}>Open dialog</button>
          <label><input type="checkbox" checked={reject} onChange={event => setReject(event.target.checked)} />Reject navigation</label>
        </div>
        <output>Opened threads: {opened}</output>
        {selected ? <div style={{ marginTop: 100 }}>
          {events.map(event => event.name === "turn.completed" ? <article key={event.id} data-notification-turn={event.turnId} data-notification-final="true" tabIndex={-1}><h2>Work finished</h2><p>The deployment plan is ready.</p></article>
            : event.name === "user_question.asked" ? <section key={event.id} data-notification-question={(event.data as { question: { id: string } }).question.id}><h2>Which environment should I use?</h2><button>Answer question</button></section>
            : event.name === "approval.requested" ? <section key={event.id} data-notification-approval={(event.data as { id: string }).id}><h2>Input needed</h2><button>Submit answer</button></section> : null)}
        </div> : null}
      </main>
      <div className="app-toast-anchor"><AppToast {...presentation} /></div>
    </div>
    {dialog ? <div role="dialog" aria-modal="true" style={{ position: "absolute", inset: 0, zIndex: 90, background: "#111e", display: "grid", placeItems: "center" }}><button onClick={() => setDialog(false)}>Close dialog</button></div> : null}
  </div>;
}
