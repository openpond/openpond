import { createPipelineActionShapeFromMetadata, type CreatePipelineRequest, type CreatePipelineSnapshot } from "@openpond/contracts";
import { FileText } from "../icons";

type CreatePipelineStatusReceiptProps = {
  request: CreatePipelineRequest;
  snapshot: CreatePipelineSnapshot | null;
};

export function CreatePipelineStatusReceipt({ request, snapshot }: CreatePipelineStatusReceiptProps) {
  const state = snapshot?.state ?? "planning";
  const plan = snapshot?.plan ?? null;
  const question = snapshot?.questions.find((item) => item.status === "pending") ?? null;
  const actionShape = createPipelineActionShapeFromMetadata(plan?.metadata);
  const source = snapshot?.sourceRefs[0] ?? plan?.sourcePlan[0]?.path ?? null;
  const checks = snapshot?.checkRefs.length || plan?.checks.length || 0;

  return (
    <section className="chat-create-receipt" aria-label="Create status">
      <div className="chat-create-receipt-heading">
        <FileText size={14} />
        <span>{createReceiptTitle(state)}</span>
        <small>{request.operation}</small>
      </div>
      <p>{createReceiptText({ state, request, planSummary: plan?.summary ?? null, questionPrompt: question?.prompt ?? null })}</p>
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
