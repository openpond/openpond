export type PonderRecommendation = {
  id: string;
  revision: number;
  kind: string;
  target: { source: "hosted"; conversationId: string; turnId: string | null; title: string; status: string; updatedAt: string; lastMessageSequence: number };
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
