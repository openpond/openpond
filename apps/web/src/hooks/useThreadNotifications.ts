import { useEffect, useRef, useState, type Dispatch } from "react";
import type { Session } from "@openpond/contracts";
import type { AppAction } from "../app/app-state";
import type { AppToast, ShowAppToast, ThreadToastTarget } from "../lib/app-toasts";
import type { RuntimeEventStore } from "../lib/runtime-event-store";
import type { RuntimeIndexes } from "../lib/runtime-indexes";
import { ThreadNotificationProjector } from "../lib/thread-notifications";

export function useThreadNotifications(input: {
  scope: string;
  afterSequence: number | null;
  store: RuntimeEventStore;
  indexes: RuntimeIndexes;
  sessions: readonly Session[];
  visibleSessionIds: ReadonlySet<string>;
  toasts: readonly AppToast[];
  showToast: ShowAppToast;
  dispatch: Dispatch<AppAction>;
  openThread: (target: ThreadToastTarget, isCurrent: () => boolean) => Promise<boolean>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const engine = useRef<{ scope: string; projector: ThreadNotificationProjector } | null>(null);
  const groups = useRef(new Set<string>());
  const [revision, setRevision] = useState(0);
  const [visibleDomIds, setVisibleDomIds] = useState<string[]>([]);
  const [focused, setFocused] = useState(() => document.hasFocus() && document.visibilityState !== "hidden");

  useEffect(() => {
    const update = () => {
      const obscured = Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'));
      const ids = obscured ? [] : [...document.querySelectorAll<HTMLElement>(".main-pane[data-thread-session], .right-chat-pane[data-thread-session]")]
        .filter(node => node.getClientRects().length > 0 && !node.closest("[inert]"))
        .map(node => node.dataset.threadSession!).sort();
      setVisibleDomIds(previous => previous.join("\0") === ids.join("\0") ? previous : ids);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-thread-session", "open", "aria-modal", "inert"] });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && document.visibilityState !== "hidden");
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    input.dispatch({ type: "clearToasts" });
    groups.current.clear();
    engine.current = null;
    return input.store.subscribeLive(events => {
      const current = latest.current;
      if (current.scope !== input.scope || current.afterSequence === null) return;
      if (!engine.current) engine.current = { scope: current.scope, projector: new ThreadNotificationProjector(current.afterSequence) };
      engine.current.projector.ingest(events, Date.now());
      setRevision(value => value + 1);
    });
  }, [input.scope, input.store, input.dispatch]);

  useEffect(() => {
    if (input.afterSequence === null) return;
    if (!engine.current || engine.current.scope !== input.scope) {
      engine.current = { scope: input.scope, projector: new ThreadNotificationProjector(input.afterSequence) };
    }
    const visible = focused ? new Set(visibleDomIds.filter(id => input.visibleSessionIds.has(id))) : new Set<string>();
    const result = engine.current.projector.reconcile({ sessions: input.sessions, indexes: input.indexes,
      visibleSessionIds: visible, now: Date.now() });
    for (const groupKey of groups.current) {
      const sessionId = groupKey.slice("thread-attention:".length);
      if ((!result.activeAttentionGroups.has(groupKey) || visible.has(sessionId))
        && latest.current.toasts.some(toast => toast.groupKey === groupKey)) input.dispatch({ type: "clearToastGroup", groupKey });
    }
    groups.current = result.activeAttentionGroups;
    for (const notification of result.notifications) {
      const existing = latest.current.toasts.find(toast => toast.groupKey === notification.groupKey);
      if ((notification.updateOnly && !existing) || existing?.dedupeKey === notification.key) continue;
      const scope = input.scope;
      input.showToast(notification.message, notification.kind === "completion" ? "success" : "info", {
        title: notification.title, detail: notification.detail, kind: notification.kind,
        groupKey: notification.groupKey, dedupeKey: notification.key, actionLabel: "Open thread",
        onAction: async () => latest.current.scope === scope
          ? latest.current.openThread(notification.target, () => latest.current.scope === scope) : false,
      });
    }
    if (result.nextDeadline === null) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), Math.max(0, result.nextDeadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [input.scope, input.afterSequence, input.indexes, input.sessions, input.visibleSessionIds,
    input.showToast, input.dispatch, focused, visibleDomIds, revision]);
}
