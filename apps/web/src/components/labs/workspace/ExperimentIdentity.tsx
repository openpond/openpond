import { useEffect, useState } from "react";
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
      <small className="evaluation-experiment-title" title={title} tabIndex={0}>
        {title || "—"}
      </small>
      <small>
        <EvaluationTime value={startedAt ?? createdAt} />
      </small>
      <small>
        {seconds === null ? "Queued" : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`}
      </small>
    </>
  );
}
