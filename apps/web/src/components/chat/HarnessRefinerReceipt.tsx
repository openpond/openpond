import { useId, useState } from "react";

import type { HarnessRefinerActivity } from "../../lib/app-models";
import { refinerActivityLabel } from "../../lib/chat-refiner-activity";
import { ChevronDown, RefreshCw } from "../icons";

export function HarnessRefinerReceipt({
  activity,
  defaultExpanded = false,
}: {
  activity: HarnessRefinerActivity;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const detailsId = useId();
  const expandable = hasDetails(activity);
  return (
    <section className={`harness-refiner-receipt ${activity.state} ${activity.result ?? ""}`}>
      <button
        aria-controls={expandable ? detailsId : undefined}
        aria-expanded={expandable ? expanded : undefined}
        className="harness-refiner-receipt-summary"
        disabled={!expandable}
        onClick={() => expandable && setExpanded((current) => !current)}
        type="button"
      >
        <RefreshCw aria-hidden className={activity.state === "running" ? "spinning" : undefined} size={12} />
        <span>{refinerActivityLabel(activity)}</span>
        {expandable ? (
          <ChevronDown
            aria-hidden
            className={`harness-refiner-receipt-toggle ${expanded ? "expanded" : ""}`}
            size={13}
          />
        ) : null}
      </button>
      {expandable && expanded ? (
        <div className="harness-refiner-receipt-details" id={detailsId}>
          <ReceiptFacts activity={activity} />
          {activity.reason ? (
            <section>
              <strong>Reason</strong>
              <p>{activity.reason}</p>
            </section>
          ) : null}
          {activity.expectedOutcome ? (
            <section>
              <strong>Expected outcome</strong>
              <p>{activity.expectedOutcome}</p>
            </section>
          ) : null}
          {activity.evidenceBasis ? (
            <section>
              <strong>Evidence basis</strong>
              <p>{activity.evidenceBasis.kind.replaceAll("_", " ")}</p>
              <small>
                {activity.evidenceBasis.supportingEvidenceIds.length} supporting item
                {activity.evidenceBasis.supportingEvidenceIds.length === 1 ? "" : "s"}
                {activity.evidenceBasis.counterevidence.length
                  ? ` · ${activity.evidenceBasis.counterevidence.length} counterexample${activity.evidenceBasis.counterevidence.length === 1 ? "" : "s"}`
                  : " · no material counterevidence"}
              </small>
            </section>
          ) : null}
          {activity.validations.length ? (
            <section>
              <strong>Validation</strong>
              <div className="harness-refiner-validation-list">
                {activity.validations.map((validation) => (
                  <div key={validation.id}>
                    <span className={validation.status}>{validation.status}</span>
                    <p>{validation.summary}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {activity.edits.length ? (
            <details className="harness-refiner-exact-edits">
              <summary>
                Review {activity.edits.length} exact edit{activity.edits.length === 1 ? "" : "s"}
              </summary>
              {activity.edits.map((edit) => (
                <section key={edit.id}>
                  <strong>{edit.operation} · {edit.target}</strong>
                  <p>{edit.summary}</p>
                  {edit.content === null ? <small>File deleted.</small> : <pre>{edit.content}</pre>}
                </section>
              ))}
            </details>
          ) : null}
          <ReceiptReferences refs={activity.refs} />
        </div>
      ) : null}
    </section>
  );
}

function ReceiptFacts({ activity }: { activity: HarnessRefinerActivity }) {
  const facts = [
    activity.route ? [activity.decision === "route" ? "Owner" : "Layer", activity.route] : null,
    activity.operation ? ["Operation", activity.operation] : null,
    activity.target ? ["Target", activity.target] : null,
    activity.critiqueStatus !== "not_applicable" ? ["Critique", activity.critiqueStatus] : null,
    activity.validationStatus !== "not_applicable" ? ["Validation", activity.validationStatus] : null,
  ].filter((fact): fact is string[] => Boolean(fact));
  return facts.length ? (
    <dl className="harness-refiner-receipt-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value?.replaceAll("_", " ")}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}

function ReceiptReferences({ refs }: { refs: HarnessRefinerActivity["refs"] }) {
  const visible = Object.entries(refs).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!visible.length) return null;
  return (
    <details className="harness-refiner-references">
      <summary>Receipt references</summary>
      <dl>
        {visible.map(([label, value]) => (
          <div key={label}>
            <dt>{sentenceCase(label)}</dt>
            <dd><code>{value}</code></dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function hasDetails(activity: HarnessRefinerActivity): boolean {
  return activity.state !== "running" && Boolean(
    activity.reason
    || activity.expectedOutcome
    || activity.route
    || activity.operation
    || activity.target
    || activity.evidenceBasis
    || activity.validations.length
    || activity.edits.length
    || Object.values(activity.refs).some(Boolean),
  );
}

function sentenceCase(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}
