import { useLayoutEffect, useRef, type RefObject } from "react";

export function useChatContentScrollScheduler(input: {
  contentKey: string;
  threadElement?: HTMLElement | null;
  enabled?: boolean;
  onContentChange: (element: HTMLElement) => void;
  threadRef: RefObject<HTMLElement | null>;
}): void {
  const {
    contentKey,
    threadElement = null,
    enabled = true,
    onContentChange,
    threadRef,
  } = input;
  const callbackRef = useRef(onContentChange);
  const scheduleRef = useRef<(() => void) | null>(null);
  callbackRef.current = onContentChange;

  useLayoutEffect(() => {
    const element = threadElement ?? threadRef.current;
    if (!enabled || !element || typeof window === "undefined") return undefined;
    let animationFrame: number | null = null;
    let remainingSettleFrames = 0;
    let lastScrollHeight = element.scrollHeight;
    const schedule = (resetSettleFrames = true) => {
      // A streamed message can change its rendered height after React has
      // committed it (for example, while markdown is laid out or an image
      // finishes loading). Keep the viewport pinned through that short layout
      // window instead of correcting it only once on the next frame.
      if (resetSettleFrames)
        remainingSettleFrames = Math.max(remainingSettleFrames, 4);
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        if (threadRef.current === element) callbackRef.current(element);
        const scrollHeightChanged =
          Math.abs(element.scrollHeight - lastScrollHeight) > 1;
        lastScrollHeight = element.scrollHeight;
        remainingSettleFrames -= 1;
        if (remainingSettleFrames > 0 || scrollHeightChanged) schedule(false);
      });
    };
    scheduleRef.current = () => schedule();
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
        syncObservedChildren();
        schedule();
      });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => schedule());
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
    const handleLoad = () => schedule();
    element.addEventListener("load", handleLoad, true);
    return () => {
      scheduleRef.current = null;
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      element.removeEventListener("load", handleLoad, true);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [enabled, threadElement, threadRef]);

  useLayoutEffect(() => {
    if (enabled) scheduleRef.current?.();
  }, [contentKey, enabled]);
}
