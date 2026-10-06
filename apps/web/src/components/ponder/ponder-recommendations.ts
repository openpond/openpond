export type PonderRecommendation = {
  id: string;
  revision: number;
  kind: string;
  target: { source: "hosted"; conversationId: string; turnId: string | null; title: string; status: string; updatedAt: string; stateRevision: string; lastMessageSequence: number };
  summary: string;
  proposedText: string | null;
  submittedText: string | null;
  submissionRevision: number | null;
  evidence: Array<{ id: string; kind: string; excerpt: string }>;
  state: "proposed" | "dismissed" | "submitting" | "submitted" | "failed" | "stale";
  receipt: unknown;
  error: string | null;
};
export type PonderNotification = { id: string; messageId: string; title: string; body: string; href: string;
  importance: "attention" | "completion"; readAt: string | null; occurredAt: string };

/** New hosted sends wait for the task owner; admitted retry identity is handled separately. */
export function hostedRecommendationSendBlocked(item: PonderRecommendation) {
  return item.state === "proposed" && ["waiting_input", "waiting_approval", "cancelled"].includes(item.target.status);
}
