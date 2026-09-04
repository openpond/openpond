import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TrainingJobEvent } from "@openpond/contracts";

import { Check, ChevronDown, ListFilter } from "../icons";
import { formatDateTime } from "../training/training-model-data";

export function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function TrainingEventLog({
  error,
  events,
  loading,
}: {
  error: string | null;
  events: TrainingJobEvent[];
  loading: boolean;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [typeSelection, setTypeSelection] = useState<Record<string, boolean>>(
    {},
  );
  const [followLatest, setFollowLatest] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const eventTypes = useMemo(() => eventTypeOptions(events), [events]);
  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          typeSelection[trainingEventType(event)] ??
          defaultEventTypeEnabled(trainingEventType(event)),
      ),
    [events, typeSelection],
  );
  const enabledTypeCount = eventTypes.filter(
    (option) =>
      typeSelection[option.id] ?? defaultEventTypeEnabled(option.id),
  ).length;
  const allTypesEnabled =
    eventTypes.length > 0 && enabledTypeCount === eventTypes.length;
  const someTypesEnabled = enabledTypeCount > 0 && !allTypesEnabled;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someTypesEnabled;
    }
  }, [someTypesEnabled]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !followLatest) return;
    log.scrollTop = log.scrollHeight;
  }, [followLatest, visibleEvents]);

  if (loading && !events.length) {
    return <div className="training-run-placeholder">Loading run events…</div>;
  }
  if (!events.length) {
    return (
      <div className="training-run-placeholder">
        {error ?? "No normalized run events were recorded."}
      </div>
    );
  }
  return (
    <div className="training-event-log-shell">
      <div className="training-event-log-toolbar">
        <div>
          <strong>Activity log</strong>
          <span>
            {visibleEvents.length.toLocaleString()} of {events.length.toLocaleString()} events
          </span>
        </div>
        <div className="training-event-filter" ref={filterRef}>
          <button
            aria-expanded={filterOpen}
            aria-haspopup="menu"
            className="training-event-filter-trigger"
            type="button"
            onClick={() => setFilterOpen((open) => !open)}
          >
            <ListFilter aria-hidden="true" size={14} />
            Event types
            <span>{enabledTypeCount}/{eventTypes.length}</span>
            <ChevronDown aria-hidden="true" size={13} />
          </button>
          {filterOpen ? (
            <div
              aria-label="Filter training activity by event type"
              className="training-event-filter-menu"
              role="menu"
            >
              <label className="training-event-filter-option select-all">
                <input
                  checked={allTypesEnabled}
                  ref={selectAllRef}
                  type="checkbox"
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    setTypeSelection(
                      Object.fromEntries(
                        eventTypes.map((option) => [option.id, enabled]),
                      ),
                    );
                  }}
                />
                <span className="training-event-filter-check">
                  <Check aria-hidden="true" size={12} />
                </span>
                Select all
              </label>
              <div className="training-event-filter-options">
                {eventTypes.map((option) => {
                  const enabled =
                    typeSelection[option.id] ??
                    defaultEventTypeEnabled(option.id);
                  return (
                    <label
                      className="training-event-filter-option"
                      key={option.id}
                    >
                      <input
                        checked={enabled}
                        type="checkbox"
                        onChange={(event) =>
                          setTypeSelection((current) => ({
                            ...current,
                            [option.id]: event.currentTarget.checked,
                          }))
                        }
                      />
                      <span className="training-event-filter-check">
                        <Check aria-hidden="true" size={12} />
                      </span>
                      <span>{option.label}</span>
                      <small>{option.count.toLocaleString()}</small>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div
        aria-label="Training activity log"
        aria-live="polite"
        className="training-event-log"
        ref={logRef}
        role="log"
        onScroll={(event) => {
          const log = event.currentTarget;
          const distanceFromBottom =
            log.scrollHeight - log.scrollTop - log.clientHeight;
          setFollowLatest(distanceFromBottom <= 6);
        }}
      >
        <div aria-hidden="true" className="training-event-log-header">
          <span>Time</span>
          <span>Event type</span>
          <span>Details</span>
        </div>
        {visibleEvents.map((event) => (
          <div
            className={`training-event-log-line ${event.type}`}
            key={event.id}
          >
            <time dateTime={event.timestamp}>
              {formatDateTime(event.timestamp)}
            </time>
            <span>{eventLabel(trainingEventType(event))}</span>
            <code>{eventSummary(event)}</code>
          </div>
        ))}
        {!visibleEvents.length ? (
          <div className="training-event-log-empty">
            No events match the selected event types.
          </div>
        ) : null}
        {error ? (
          <div className="training-event-log-line failure">
            <time>—</time>
            <span>Failure</span>
            <code>{error}</code>
          </div>
        ) : null}
      </div>
      <span className="training-event-follow-state" data-following={followLatest}>
        {followLatest ? "Following new events" : "Scroll to the bottom to resume live follow"}
      </span>
    </div>
  );
}

export function trainingEventType(event: TrainingJobEvent): string {
  if (
    typeof event.payload.remoteEventType === "string" &&
    event.payload.remoteEventType.trim()
  ) {
    return event.payload.remoteEventType;
  }
  if (
    typeof event.payload.telemetryType === "string" &&
    event.payload.telemetryType.trim()
  ) {
    return event.payload.telemetryType;
  }
  return event.type;
}

function eventTypeOptions(events: TrainingJobEvent[]) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const type = trainingEventType(event);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count, label: eventLabel(id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function defaultEventTypeEnabled(type: string): boolean {
  return type !== "metric";
}

function eventLabel(type: string): string {
  return type
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export function eventSummary(event: TrainingJobEvent): string {
  const payload = event.payload;
  const step = finiteNumber(payload.step);
  const maxSteps = finiteNumber(payload.maxSteps);
  if (typeof payload.telemetryType === "string") {
    const message =
      typeof payload.message === "string" ? payload.message : null;
    const errorCode =
      typeof payload.errorCode === "string" ? payload.errorCode : null;
    const source =
      typeof payload.telemetrySource === "string"
        ? ` · ${payload.telemetrySource}`
        : "";
    return `${message ?? payload.telemetryType.replaceAll("_", " ")}${
      step == null ? "" : ` · step ${step}`
    }${source}${errorCode ? ` · ${errorCode}` : ""}`;
  }
  if (typeof payload.remoteEventType === "string") {
    const label = remoteEventLabel(payload.remoteEventType);
    const phase =
      typeof payload.remotePhase === "string"
        ? remotePhaseLabel(payload.remotePhase)
        : null;
    const errorCode =
      typeof payload.errorCode === "string" && payload.errorCode.trim()
        ? payload.errorCode.trim()
        : null;
    return [
      label,
      phase,
      step == null ? null : `step ${step}`,
      errorCode ? `error ${errorCode}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (event.type === "start") {
    return typeof payload.device === "string"
      ? `Worker started on ${payload.device}.`
      : "Worker started.";
  }
  if (event.type === "progress" && step != null) {
    return maxSteps == null ? `Step ${step}.` : `Step ${step} of ${maxSteps}.`;
  }
  if (event.type === "metric") {
    const kind =
      typeof payload.metricKind === "string"
        ? payload.metricKind.replaceAll("_", " ")
        : "metric";
    const values = [
      numericSummary("loss", payload.loss),
      numericSummary("reward", payload.meanReward ?? payload.reward),
      numericSummary("policy loss", payload.policyLoss),
      numericSummary("value loss", payload.valueLoss),
      numericSummary(
        "preference accuracy",
        payload.preferenceAccuracy,
        percentValue,
      ),
    ].filter((value): value is string => Boolean(value));
    const failureClass =
      typeof payload.failureClass === "string" ? payload.failureClass : null;
    const failureCode =
      typeof payload.failureCode === "string" ? payload.failureCode : null;
    const managedMetric =
      typeof payload.metricId === "string" &&
      typeof payload.value === "number"
        ? ` · ${payload.metricId}: ${payload.value.toPrecision(4)}`
        : "";
    return `${kind}${step == null ? "" : ` · step ${step}`}${managedMetric}${
      failureClass ? ` · ${failureClass}` : ""
    }${failureCode ? ` · ${failureCode}` : ""}${
      values.length ? ` · ${values.join(" · ")}` : ""
    }`;
  }
  if (event.type === "checkpoint") {
    const policyVersion = finiteNumber(payload.policyVersion);
    const sizeBytes = finiteNumber(payload.sizeBytes);
    const details = [
      policyVersion == null ? null : `policy ${policyVersion}`,
      sizeBytes == null ? null : formatBytes(sizeBytes),
      payload.final === true ? "final" : null,
    ].filter((value): value is string => Boolean(value));
    return details.length
      ? `Checkpoint committed · ${details.join(" · ")}.`
      : "Checkpoint committed.";
  }
  if (event.type === "complete") {
    const artifactCount = finiteNumber(payload.artifactCount);
    return artifactCount == null
      ? "Worker completed."
      : `Worker completed with ${artifactCount} artifacts.`;
  }
  if (event.type === "failure" && typeof payload.message === "string") {
    return payload.message;
  }
  return Object.keys(payload).length ? JSON.stringify(payload) : "Recorded.";
}

function remoteEventLabel(value: string): string {
  const known: Record<string, string> = {
    drain: "Rollout drain",
    infer: "Model inference",
    materialize_checkpoint: "Checkpoint materialization",
    optimizer_metric: "Optimizer metric",
    provision_gpu: "GPU provisioning",
    rollout_metric: "Rollout trajectory",
    score_reward_model: "Reward scoring",
    start_inference: "Policy server",
    train_step: "Optimizer update",
    upload_checkpoint: "Checkpoint upload",
  };
  return known[value] ?? humanizeEventValue(value);
}

function remotePhaseLabel(value: string): string {
  const known: Record<string, string> = {
    committed: "committed",
    completed: "completed",
    eligible: "recorded",
    failed: "failed",
    running: "running",
    succeeded: "succeeded",
  };
  return known[value] ?? humanizeEventValue(value).toLocaleLowerCase();
}

function humanizeEventValue(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function numericSummary(
  label: string,
  value: unknown,
  format: (value: number) => string = (number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
      number,
    ),
): string | null {
  const number = finiteNumber(value);
  return number == null ? null : `${label} ${format(number)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentValue(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
