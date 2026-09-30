import { chatModelLabel } from "../../../lib/app-models";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { Check, Circle, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";

dayjs.extend(relativeTime);

export function EvaluationStatus({ status }: { status: string }) {
  const value = status.toLowerCase();
  const success = ["completed", "passed", "ready", "published", "scored"].includes(value);
  const failure = ["failed", "error", "rejected"].includes(value);
  const progress = ["queued", "running", "cancelling", "checking", "pending"].includes(value);
  const Icon = success ? Check : failure ? X : progress ? LoaderCircle : Circle;
  return <span className={`evaluation-status evaluation-status-${success ? "success" : failure ? "error" : progress ? "progress" : "neutral"}`}><Icon size={13} aria-hidden="true" />{status.replaceAll("_", " ")}</span>;
}

export function EvaluationModel({ name, onOpen }: { name: string; onOpen?: () => void }) {
  return onOpen ? <button type="button" className="evaluation-model" onClick={event => { event.stopPropagation(); onOpen(); }}>{chatModelLabel(name)}</button> : <span className="evaluation-model">{chatModelLabel(name)}</span>;
}

export function EvaluationTime({ value }: { value?: string | null }) {
  const date = value ? dayjs(value) : null;
  if (!date?.isValid()) return <span>Unknown</span>;
  const exact = `${date.format("MMM D, YYYY h:mm:ss A Z")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  return <span className="evaluation-time" tabIndex={0} aria-label={exact}><time dateTime={date.toISOString()}>{date.fromNow()}</time><span role="tooltip">{exact}</span></span>;
}

export function EvaluationCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="evaluation-card"><h3>{title}</h3>{children}</section>;
}
