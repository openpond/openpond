import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

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
  onOpen,
}: {
  id: string;
  title?: string;
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
  return (
    <div className="evaluation-identity">
      <div className="evaluation-identity-text">
        <button
          type="button"
          className="evaluation-identity-name"
          title={`${title || id}\n${id}`}
          onClick={onOpen}
          onMouseEnter={revealTitle}
          onFocus={revealTitle}
          onMouseLeave={resetTitle}
          onBlur={resetTitle}
        >
          <span ref={titleRef}>{title || id}</span>
        </button>
        <span className="evaluation-identity-meta">
          <code title={id}>{id.replace(/^(mrun_|local_)/, "").slice(0, 12)}</code>
          <button
            type="button"
            className="evaluation-copy-id"
            aria-label={`Copy experiment ID ${id}`}
            title={copied ? "Copied" : "Copy ID"}
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard
                .writeText(id)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </span>
      </div>
    </div>
  );
}

/** Wall-clock run length; running Experiments tick against the shared clock. */
export function experimentElapsed(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  now: number,
) {
  if (!startedAt) return null;
  const seconds = Math.max(
    0,
    Math.floor(((completedAt ? Date.parse(completedAt) : now) - Date.parse(startedAt)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
