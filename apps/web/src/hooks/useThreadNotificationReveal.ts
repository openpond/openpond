import { useEffect, useRef } from "react";
import type { ThreadToastTarget } from "../lib/app-toasts";

const REVEAL_EVENT = "openpond-thread-notification-reveal";
export function requestThreadNotificationReveal(target: ThreadToastTarget) {
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: target }));
}

export function useThreadNotificationReveal(scope: string) {
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    const reveal = (event: Event) => {
      cleanup?.();
      const target = (event as CustomEvent<ThreadToastTarget>).detail;
      const matches = (node: HTMLElement) => target.approvalId ? node.dataset.notificationApproval === target.approvalId
        : target.runId ? node.dataset.notificationRun === target.runId
        : target.questionId ? node.dataset.notificationQuestion === target.questionId
        : node.dataset.notificationTurn === target.turnId && node.dataset.notificationFinal === "true";
      let frame = 0;
      const tryReveal = () => {
        if (activeScope.current !== scope) { cleanup?.(); return; }
        const pane = document.querySelector<HTMLElement>(`.main-pane[data-thread-session="${CSS.escape(target.sessionId)}"]`);
        if (!pane) return;
        const node = [...pane.querySelectorAll<HTMLElement>("[data-notification-approval], [data-notification-question], [data-notification-turn], [data-notification-run]")].find(matches);
        if (!node) return;
        cleanup?.();
        frame = requestAnimationFrame(() => {
          node.scrollIntoView({ block: "center", behavior: "instant" });
          const control = node.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)");
          if (control) control.focus({ preventScroll: true });
          else { node.tabIndex = -1; node.focus({ preventScroll: true }); }
        });
      };
      const observer = new MutationObserver(tryReveal);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-thread-session"] });
      const timeout = window.setTimeout(() => {
        cleanup?.();
        const pane = document.querySelector<HTMLElement>(`.main-pane[data-thread-session="${CSS.escape(target.sessionId)}"]`);
        pane?.focus({ preventScroll: true });
      }, 10_000);
      cleanup = () => { observer.disconnect(); window.clearTimeout(timeout); cancelAnimationFrame(frame); };
      tryReveal();
    };
    window.addEventListener(REVEAL_EVENT, reveal);
    return () => { cleanup?.(); window.removeEventListener(REVEAL_EVENT, reveal); };
  }, [scope]);
}
