import { useEffect, useRef, useState } from "react";
import { EvaluationTime } from "./EvaluationPresentation";
export function useExperimentClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
export function ExperimentIdentity({
  id,
  title,
  startedAt,
  createdAt,
  completedAt,
  now,
  onOpen,
}: {
  id: string;
  title?: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  now: number;
  onOpen: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<Animation | null>(null);
  function revealTitle() {
    const node = titleRef.current;
    if (
      !node ||
      animationRef.current ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const distance = node.scrollWidth - node.clientWidth;
    if (distance <= 0) return;
    node.style.textOverflow = "clip";
    node.style.overflow = "visible";
    animationRef.current = node.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: 0.15 },
        { transform: `translateX(-${distance}px)`, offset: 0.85 },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ],
      {
        duration: Math.max(2500, distance * 35),
        iterations: Infinity,
        direction: "alternate",
        easing: "linear",
      },
    );
  }
  function resetTitle(event: React.SyntheticEvent<HTMLElement>) {
    if (event.currentTarget.matches(":hover, :focus-within")) return;
    animationRef.current?.cancel();
    animationRef.current = null;
    if (titleRef.current) {
      titleRef.current.style.textOverflow = "ellipsis";
      titleRef.current.style.overflow = "hidden";
    }
  }
  useEffect(() => () => animationRef.current?.cancel(), []);
  const seconds = startedAt
    ? Math.max(
        0,
        Math.floor(((completedAt ? Date.parse(completedAt) : now) - Date.parse(startedAt)) / 1000),
      )
    : null;
  return (
    <>
      <span className="evaluation-identity">
        <button className="training-text-button" title={id} onClick={onOpen}>
          {id.replace(/^(mrun_|local_)/, "").slice(0, 12)}
        </button>
        <button
          type="button"
          className="training-text-button evaluation-copy-id"
          aria-label={`Copy experiment ID ${id}`}
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard
              .writeText(id)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
      <small
        className="evaluation-experiment-title"
        title={title}
        tabIndex={0}
        onMouseEnter={revealTitle}
        onFocus={revealTitle}
        onMouseLeave={resetTitle}
        onBlur={resetTitle}
      >
        <span ref={titleRef}>{title || "—"}</span>
      </small>
      <small>
        <EvaluationTime value={startedAt ?? createdAt} />
      </small>
      <small>
        {seconds === null
          ? completedAt
            ? "Elapsed unavailable"
            : "—"
          : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`}
      </small>
    </>
  );
}
