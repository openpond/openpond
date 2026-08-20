import { useLayoutEffect, useRef, type RefObject } from "react";

export function useChatContentScrollScheduler(input: {
  contentKey: string;
  enabled?: boolean;
  onContentChange: (element: HTMLElement) => void;
  threadRef: RefObject<HTMLElement | null>;
}): void {
  const { contentKey, enabled = true, onContentChange, threadRef } = input;
  const callbackRef = useRef(onContentChange);
  const scheduleRef = useRef<(() => void) | null>(null);
  callbackRef.current = onContentChange;

  useLayoutEffect(() => {
    const element = threadRef.current;
    if (!enabled || !element || typeof window === "undefined") return undefined;
    let animationFrame: number | null = null;
    const schedule = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        if (threadRef.current === element) callbackRef.current(element);
      });
    };
    scheduleRef.current = schedule;
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
        syncObservedChildren();
        schedule();
      });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedule);
    const observedChildren = new Set<HTMLElement>();
    const syncObservedChildren = () => {
      if (!resizeObserver) return;
      const currentChildren = new Set(
        Array.from(element.children).filter(
          (child): child is HTMLElement => child instanceof HTMLElement,
        ),
      );
      for (const child of observedChildren) {
        if (!currentChildren.has(child)) {
          resizeObserver.unobserve(child);
          observedChildren.delete(child);
        }
      }
      for (const child of currentChildren) {
        if (!observedChildren.has(child)) {
          resizeObserver.observe(child);
          observedChildren.add(child);
        }
      }
    };
    mutationObserver?.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    syncObservedChildren();
    element.addEventListener("load", schedule, true);
    return () => {
      scheduleRef.current = null;
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      element.removeEventListener("load", schedule, true);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [enabled, threadRef]);

  useLayoutEffect(() => {
    if (enabled) scheduleRef.current?.();
  }, [contentKey, enabled]);
}
