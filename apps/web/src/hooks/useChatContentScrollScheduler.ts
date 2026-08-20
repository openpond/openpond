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
    const observer = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(schedule);
    observer?.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    element.addEventListener("load", schedule, true);
    return () => {
      scheduleRef.current = null;
      observer?.disconnect();
      element.removeEventListener("load", schedule, true);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [enabled, threadRef]);

  useLayoutEffect(() => {
    if (enabled) scheduleRef.current?.();
  }, [contentKey, enabled]);
}
