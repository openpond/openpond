import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Lightbulb } from "../icons";
import type { InsightsRunPromptEvidenceItem, InsightsRunPromptSummary } from "../../lib/app-models";

const INSIGHTS_EVIDENCE_VISIBLE_LIMIT = 5;

export function InsightsRunPromptCard({ prompt }: { prompt: InsightsRunPromptSummary }) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = useMemo(
    () => (expanded ? prompt.items : prompt.items.slice(0, INSIGHTS_EVIDENCE_VISIBLE_LIMIT)),
    [expanded, prompt.items],
  );
  const hiddenCount = Math.max(0, prompt.items.length - visibleItems.length);
  const totalCount = prompt.totalEvidenceCount || prompt.items.length;
  return (
    <div className="insights-run-prompt-card">
      <div className="insights-run-prompt-heading">
        <span className="insights-run-prompt-icon" aria-hidden="true">
          <Lightbulb size={15} />
        </span>
        <div>
          <strong>Insights scan</strong>
          <span>{insightsRunMeta(prompt, totalCount)}</span>
        </div>
      </div>
      {visibleItems.length > 0 ? (
        <div className="insights-run-evidence-list">
          {visibleItems.map((item, index) => (
            <InsightsRunEvidenceRow item={item} key={`${item.evidenceSource}:${item.evidenceKey}:${index}`} />
          ))}
        </div>
      ) : (
        <p className="insights-run-empty">No evidence items were included.</p>
      )}
      {prompt.items.length > INSIGHTS_EVIDENCE_VISIBLE_LIMIT ? (
        <button
          type="button"
          className="insights-run-show-more"
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? "Show less" : `Show ${hiddenCount} more`}</span>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : null}
    </div>
  );
}

function InsightsRunEvidenceRow({ item }: { item: InsightsRunPromptEvidenceItem }) {
  const title = item.title ?? evidenceSourceLabel(item.evidenceSource);
  const detail = item.summary ?? item.evidenceKey;
  const state = item.createPipelineState ?? item.type ?? item.severity;
  return (
    <div className="insights-run-evidence-row">
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="insights-run-evidence-meta">
        <span>{evidenceSourceLabel(item.evidenceSource)}</span>
        {state ? <span>{state}</span> : null}
      </div>
    </div>
  );
}

function insightsRunMeta(prompt: InsightsRunPromptSummary, totalCount: number): string {
  const parts = [
    prompt.trigger ? `${prompt.trigger} run` : "run",
    `${totalCount} evidence item${totalCount === 1 ? "" : "s"}`,
  ];
  if (prompt.eventCount !== null) parts.push(`${prompt.eventCount} events`);
  if (prompt.truncated) parts.push("JSON truncated");
  return parts.join(" · ");
}

function evidenceSourceLabel(source: string): string {
  switch (source) {
    case "create_edit":
      return "Create/edit";
    case "stuck_turn":
      return "Stuck turn";
    case "tool_failure":
      return "Tool failure";
    case "abandoned_goal":
      return "Abandoned goal";
    case "user_correction":
      return "Correction";
    case "unresolved_conversation":
      return "Unresolved";
    case "usage_anomaly":
      return "Usage";
    default:
      return source || "Evidence";
  }
}
