import { useMemo, useState } from "react";
import { createPipelineActionShapeFromMetadata, type CreatePipelineRequest, type CreatePipelineSnapshot } from "@openpond/contracts";
import type { ActivityItem } from "../../lib/app-models";
import { ChevronDown, ChevronUp, FileText } from "../icons";

type CreatePipelineStatusReceiptProps = {
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
  progressActivities?: ActivityItem[];
};

export function CreatePipelineStatusReceipt({ request, snapshot, progressActivities = [] }: CreatePipelineStatusReceiptProps) {
  const state = snapshot?.state ?? "planning";
  const plan = snapshot?.plan ?? null;
  const question = snapshot?.questions.find((item) => item.status === "pending") ?? null;
  const actionShape = createPipelineActionShapeFromMetadata(plan?.metadata);
  const source = snapshot?.sourceRefs[0] ?? plan?.sourcePlan[0]?.path ?? null;
  const checks = snapshot?.checkRefs.length || plan?.checks.length || 0;
  const progressItems = useMemo(() => createProgressItems(progressActivities), [progressActivities]);

  return (
    <section className="chat-create-receipt" aria-label="Create status">
      <div className="chat-create-receipt-heading">
        <FileText size={14} />
        <span>{createReceiptTitle(state)}</span>
        <small>{request.operation}</small>
      </div>
      <p>{createReceiptText({ state, request, planSummary: plan?.summary ?? null, questionPrompt: question?.prompt ?? null })}</p>
      {progressItems.length ? <CreateProgressFeed items={progressItems} /> : null}
      {actionShape || source || checks ? (
        <div className="chat-create-receipt-facts">
          {actionShape ? <span title={actionShape.detail}>{actionShape.label}</span> : null}
          {source ? <span title={source}>{source}</span> : null}
          {checks ? <span>{checks} checks</span> : null}
        </div>
      ) : null}
    </section>
  );
}

type CreateProgressItem = {
  id: string;
  label: string;
  content: string;
  state?: ActivityItem["state"];
};

function CreateProgressFeed({ items }: { items: CreateProgressItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const latest = items[items.length - 1];
  if (!latest) return null;
  const visibleItems = expanded ? items : [latest];
  return (
    <div className="chat-create-progress" aria-label="Create progress">
      <button
        type="button"
        className="chat-create-progress-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        <span>{expanded ? "Hide progress" : "Show progress"}</span>
      </button>
      <ol className="chat-create-progress-list">
        {visibleItems.map((item) => (
          <li key={item.id} className={item.state ?? ""}>
            <strong>{item.label}</strong>
            <span>{item.content}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function createProgressItems(activities: ActivityItem[]): CreateProgressItem[] {
  return activities
    .map((activity) => ({
      id: activity.id,
      label: createProgressLabel(activity),
      content: createProgressContent(activity),
      state: activity.state,
    }))
    .filter((item) => item.content)
    .slice(-8);
}

function createProgressLabel(activity: ActivityItem): string {
  if (activity.label === "assistant delta") return "Working";
  if (activity.label === "assistant reasoning delta") return "Reasoning";
  return activity.label;
}

function createProgressContent(activity: ActivityItem): string {
  const detail = activity.detail?.trim();
  const content = activity.content.trim();
  const value = detail || content || activity.meta?.trim() || "";
  return value.replace(/\s+/g, " ").slice(0, 280);
}

function createReceiptTitle(state: string): string {
  if (state === "awaiting_questions") return "Create question";
  if (state === "awaiting_plan_approval") return "Create plan ready";
  if (state === "applying_source") return "Applying create plan";
  if (state === "running_checks") return "Running create checks";
  if (state === "ready_local") return "Create ready locally";
  if (state === "blocked") return "Create blocked";
  if (state === "failed") return "Create failed";
  return "Create planning";
}

function createReceiptText(input: {
  state: string;
  request: CreatePipelineRequest;
  planSummary: string | null;
  questionPrompt: string | null;
}): string {
  if (input.state === "awaiting_questions" && input.questionPrompt) {
    return input.questionPrompt;
  }
  if (input.planSummary) return input.planSummary;
  if (input.state === "blocked" || input.state === "failed") {
    return "Create needs attention before it can continue.";
  }
  if (input.state === "ready_local") return "Generated source is ready locally.";
  return `Preparing a create plan for ${input.request.objective}.`;
}
