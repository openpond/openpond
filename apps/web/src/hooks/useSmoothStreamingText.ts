import { useEffect, useRef, useState } from "react";

const BASE_CHARACTERS_PER_SECOND = 64;
const MEDIUM_BACKLOG_CHARACTERS_PER_SECOND = 120;
const LARGE_BACKLOG_CHARACTERS_PER_SECOND = 210;
const VERY_LARGE_BACKLOG_CHARACTERS_PER_SECOND = 360;
const MEDIUM_BACKLOG_LENGTH = 40;
const LARGE_BACKLOG_LENGTH = 120;
const VERY_LARGE_BACKLOG_LENGTH = 600;
const MAX_FRAME_ELAPSED_MS = 64;
const REVEAL_INTERVAL_MS = 16;

export type StreamingRevealStep = {
  characterCount: number;
  remainder: number;
};

export function streamingRevealStep(
  backlogLength: number,
  elapsedMs: number,
  remainder = 0
): StreamingRevealStep {
  if (backlogLength <= 0) {
    return { characterCount: 0, remainder: 0 };
  }

  const charactersPerSecond =
    backlogLength > VERY_LARGE_BACKLOG_LENGTH
      ? VERY_LARGE_BACKLOG_CHARACTERS_PER_SECOND
      : backlogLength > LARGE_BACKLOG_LENGTH
        ? LARGE_BACKLOG_CHARACTERS_PER_SECOND
        : backlogLength > MEDIUM_BACKLOG_LENGTH
          ? MEDIUM_BACKLOG_CHARACTERS_PER_SECOND
          : BASE_CHARACTERS_PER_SECOND;
  const characterProgress =
    remainder +
    (Math.min(Math.max(elapsedMs, 0), MAX_FRAME_ELAPSED_MS) *
      charactersPerSecond) /
      1_000;
  const characterCount = Math.min(
    backlogLength,
    Math.floor(characterProgress)
  );

  return {
    characterCount,
    remainder: characterProgress - characterCount,
  };
}

export function nextStreamingText(
  current: string,
  target: string,
  characterCount: number
): string {
  let end = Math.min(target.length, current.length + characterCount);
  const finalCodeUnit = target.charCodeAt(end - 1);
  const nextCodeUnit = target.charCodeAt(end);
  const splitsSurrogatePair =
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff;
  if (splitsSurrogatePair) end += 1;
  return target.slice(0, end);
}

function shouldAnimate(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function initialStreamingText(
  content: string,
  animateInitialContent: boolean,
  animationAllowed: boolean
): string {
  return animateInitialContent && animationAllowed
    ? nextStreamingText("", content, 1)
    : content;
}

/** Smooths appended model text independently of provider delta boundaries. */
export function useSmoothStreamingText(
  content: string,
  animateInitialContent = false
): string {
  const [visibleContent, setVisibleContent] = useState(() =>
    initialStreamingText(content, animateInitialContent, shouldAnimate())
  );
  const visibleContentRef = useRef(visibleContent);
  const targetContentRef = useRef(content);
  const revealTimerRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const remainderRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    targetContentRef.current = content;

    if (!shouldAnimate() || !content.startsWith(visibleContentRef.current)) {
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      lastFrameTimeRef.current = null;
      remainderRef.current = 0;
      visibleContentRef.current = content;
      if (mountedRef.current) setVisibleContent(content);
      return;
    }

    if (
      visibleContentRef.current.length === content.length ||
      revealTimerRef.current !== null
    ) {
      return;
    }

    const revealNextCharacters = () => {
      if (!mountedRef.current) {
        revealTimerRef.current = null;
        return;
      }
      const current = visibleContentRef.current;
      const target = targetContentRef.current;
      const timestamp = performance.now();
      if (!target.startsWith(current)) {
        visibleContentRef.current = target;
        setVisibleContent(target);
        revealTimerRef.current = null;
        lastFrameTimeRef.current = null;
        remainderRef.current = 0;
        return;
      }

      const backlogLength = target.length - current.length;
      if (backlogLength === 0) {
        revealTimerRef.current = null;
        lastFrameTimeRef.current = null;
        remainderRef.current = 0;
        return;
      }

      const elapsedMs =
        lastFrameTimeRef.current === null
          ? 16
          : timestamp - lastFrameTimeRef.current;
      const step = streamingRevealStep(
        backlogLength,
        elapsedMs,
        remainderRef.current
      );
      lastFrameTimeRef.current = timestamp;
      remainderRef.current = step.remainder;

      if (step.characterCount > 0) {
        const nextContent = nextStreamingText(
          current,
          target,
          step.characterCount
        );
        visibleContentRef.current = nextContent;
        setVisibleContent(nextContent);
      }

      revealTimerRef.current = window.setTimeout(
        revealNextCharacters,
        REVEAL_INTERVAL_MS
      );
    };

    revealTimerRef.current = window.setTimeout(
      revealNextCharacters,
      REVEAL_INTERVAL_MS
    );
    return () => {
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, [content]);

  useEffect(() => {
    const finishWhenHidden = () => {
      if (document.visibilityState === "visible") return;
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      lastFrameTimeRef.current = null;
      remainderRef.current = 0;
      visibleContentRef.current = targetContentRef.current;
      if (mountedRef.current) setVisibleContent(targetContentRef.current);
    };
    document.addEventListener("visibilitychange", finishWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", finishWhenHidden);
      if (revealTimerRef.current !== null) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, []);

  return visibleContent;
}
