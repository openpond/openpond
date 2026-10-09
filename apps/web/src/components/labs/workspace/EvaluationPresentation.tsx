import { chatModelLabel } from "../../../lib/app-models";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { Check, Circle, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

dayjs.extend(relativeTime);
export const evaluationRelativeTime = (value: string) => dayjs(value).isValid() ? dayjs(value).fromNow() : "Unknown time";

export function EvaluationStatus({ status, iconOnly=false }: { status: string; iconOnly?:boolean }) {
  const value = status.toLowerCase();
  const success = ["completed", "passed", "ready", "published", "scored"].includes(value);
  const failure = ["failed", "error", "rejected"].includes(value);
  const progress = ["queued", "running", "cancelling", "checking", "pending"].includes(value);
  const Icon = success ? Check : failure ? X : progress ? LoaderCircle : Circle;
  return <span title={status.replaceAll("_", " ")} aria-label={status.replaceAll("_", " ")} className={`evaluation-status evaluation-status-${success ? "success" : failure ? "error" : progress ? "progress" : "neutral"}`}><Icon size={13} aria-hidden="true" />{iconOnly ? null : status.replaceAll("_", " ")}</span>;
}

export function EvaluationModel({ name, onOpen }: { name: string; onOpen?: () => void }) {
  return onOpen ? <button type="button" className="evaluation-model" onClick={event => { event.stopPropagation(); onOpen(); }}>{chatModelLabel(name)}</button> : <span className="evaluation-model">{chatModelLabel(name)}</span>;
}

export function EvaluationTime({ value }: { value?: string | null }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const visible = hovered || focused;
  useEffect(() => {
    if (!visible) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: window.innerHeight - rect.bottom < 80 ? Math.max(12, rect.top - 72) : rect.bottom + 8 });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [visible]);
  const date = value ? dayjs(value) : null;
  if (!date?.isValid()) return <span>Unknown</span>;
  const exact = `${date.format("MMM D, YYYY h:mm:ss A Z")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  return <span ref={anchor} className="evaluation-time" tabIndex={0} aria-label={exact} aria-describedby={visible ? tooltipId : undefined} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={event => { if (event.key === "Escape") { setHovered(false); setFocused(false); } }}><time dateTime={date.toISOString()}>{date.fromNow()}</time>{visible && position ? createPortal(<span id={tooltipId} className="evaluation-time-tooltip" role="tooltip" style={position}>{exact}</span>, document.body) : null}</span>;
}

export function EvaluationCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="evaluation-card"><h3>{title}</h3>{children}</section>;
}
