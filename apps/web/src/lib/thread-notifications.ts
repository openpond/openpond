import {
  SessionUserQuestionSchema, SessionUserQuestionResolutionSchema,
  TaskInputSchema, type RuntimeEvent, type Session,
} from "@openpond/contracts";
import type { ThreadToastTarget } from "./app-toasts";
import type { RuntimeIndexes } from "./runtime-indexes";
import { latestCreateImproveRunFromEvents } from "./create-pipeline-runtime";
import { latestKnownActiveGoalRuntimeFromEvents, activeGoalRuntimeFromSessionMetadata, latestGoalRuntimeFromEvents } from "./goal-runtime";

export type ThreadNotification = {
  key: string;
  groupKey: string;
  title: string;
  message: string;
  detail?: string;
  kind: "attention" | "completion";
  target: ThreadToastTarget;
  updateOnly?: boolean;
};
type Request = { key: string; title: string; preview?: string; target: ThreadToastTarget };
type Completion = { event: RuntimeEvent; readyAt: number };
export const COMPLETION_SETTLE_MS = 600;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function notificationPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function pendingRequests(sessionId: string, indexes: RuntimeIndexes): Request[] {
  const events = indexes.eventsBySessionId.get(sessionId) ?? [];
  const questions = new Map<string, Request>();
  for (const event of events) {
    const data = record(event.data);
    if (event.name === "user_question.asked") {
      const parsed = SessionUserQuestionSchema.safeParse(data?.question);
      if (parsed.success && parsed.data.sessionId === sessionId && parsed.data.status === "pending") {
        const question = parsed.data;
        questions.set(question.id, { key: `question:${question.id}`, title: "Question for you", preview: question.question,
          target: { sessionId, questionId: question.id, turnId: question.turnId } });
      }
    }
    if (event.name === "user_question.answered" || event.name === "user_question.dismissed") {
      const parsed = SessionUserQuestionResolutionSchema.safeParse(data?.resolution);
      if (parsed.success) questions.delete(parsed.data.questionId);
    }
  }
  const requests = [...questions.values()];
  for (const approval of indexes.pendingApprovalsBySessionId.get(sessionId) ?? []) {
    requests.push({ key: `approval:${approval.id}`, title: approval.kind === "user_input" ? "Input needed" : "Approval needed",
      // Approval detail may contain tool arguments; only display the thread title.
      target: { sessionId, approvalId: approval.id } });
  }
  const run = latestCreateImproveRunFromEvents(events);
  if (run) {
    if (run.state === "awaiting_questions") {
      for (const question of run.questions.filter(question => question.status === "pending")) {
        requests.push({ key: `run:${run.id}:question:${question.id}`, title: "Question for you", preview: question.prompt,
          target: { sessionId, runId: run.id, questionId: question.id } });
      }
    } else if (["awaiting_plan_approval", "awaiting_promotion"].includes(run.state)
      && !requests.some(request => request.key.startsWith("approval:"))) {
      requests.push({ key: `run:${run.id}:${run.state}`, title: "Approval needed", target: { sessionId, runId: run.id } });
    }
  }
  return requests;
}

function lastEvent(events: RuntimeEvent[], names: string[]): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (names.includes(event.name)) return event;
  }
}

function eligible(session: Session): boolean {
  const metadata = record(session.metadata);
  return !session.archived && !session.systemKind && !session.id.startsWith("codex-history:")
    && metadata?.readOnly !== true && metadata?.nativeReadOnly !== true
    && !(metadata?.nativeHistoryProjection && (!session.nativeAgent || metadata.nativeBranch));
}

function continues(session: Session, completion: RuntimeEvent, indexes: RuntimeIndexes): boolean {
  const events = indexes.eventsBySessionId.get(session.id) ?? [];
  const terminal = lastEvent(events, ["turn.completed", "turn.failed", "turn.interrupted"]);
  if (!terminal || terminal.id !== completion.id || terminal.name !== "turn.completed") return true;
  const started = lastEvent(events, ["turn.started"]);
  if (started?.turnId && completion.turnId && started.turnId !== completion.turnId) return true;
  if (latestKnownActiveGoalRuntimeFromEvents(events) || activeGoalRuntimeFromSessionMetadata(session.metadata)) return true;
  const goal = latestGoalRuntimeFromEvents(events);
  if (goal && !["done"].includes(goal.tone)) return true;
  if ((indexes.latestSubagentRuntimeBySessionId.get(session.id)?.activeCount ?? 0) > 0) return true;
  const inputs = new Map<string, string>();
  for (const event of events) {
    if (event.name !== "task.input") continue;
    const parsed = TaskInputSchema.safeParse(record(event.data)?.input);
    if (parsed.success && parsed.data.sessionId === session.id) inputs.set(parsed.data.id, parsed.data.state);
  }
  return [...inputs.values()].some(state => state === "pending" || state === "included");
}

/** Owns replay identities; loaded history is state, never notification evidence. */
export class ThreadNotificationProjector {
  private seenEvents = new Set<string>();
  private seenRequests = new Set<string>();
  private completions = new Map<string, Completion>();
  private cursor: number;
  private initialized = false;
  private attentionSessions = new Set<string>();

  constructor(afterSequence: number) { this.cursor = afterSequence; }

  ingest(events: readonly RuntimeEvent[], now: number): void {
    for (const event of events) {
      if (this.seenEvents.has(event.id) || (event.sequence !== undefined && event.sequence <= this.cursor)) continue;
      this.seenEvents.add(event.id);
      // Do not advance the cursor inside a batch: sessions can arrive out of order.
      if (!event.sessionId) continue;
      if (["user_question.asked", "approval.requested", "create_improve.updated"].includes(event.name)) this.attentionSessions.add(event.sessionId);
      if (event.name === "turn.completed") this.completions.set(event.sessionId, { event, readyAt: now + COMPLETION_SETTLE_MS });
      else if (["turn.started", "turn.failed", "turn.interrupted", "user_question.asked", "approval.requested"].includes(event.name)) {
        this.completions.delete(event.sessionId);
      }
    }
    for (const event of events) if (event.sequence !== undefined) this.cursor = Math.max(this.cursor, event.sequence);
    if (this.seenEvents.size > 10_000) this.seenEvents = new Set([...this.seenEvents].slice(-5_000));
  }

  reconcile(input: {
    sessions: readonly Session[];
    indexes: RuntimeIndexes;
    visibleSessionIds: ReadonlySet<string>;
    now: number;
  }): { notifications: ThreadNotification[]; activeAttentionGroups: Set<string>; nextDeadline: number | null } {
    const notifications: ThreadNotification[] = [];
    const activeAttentionGroups = new Set<string>();
    let nextDeadline: number | null = null;
    for (const session of input.sessions) {
      if (!eligible(session)) { this.completions.delete(session.id); continue; }
      const attentionEvidence = this.attentionSessions.has(session.id);
      this.attentionSessions.delete(session.id);
      const requests = pendingRequests(session.id, input.indexes);
      const groupKey = `thread-attention:${session.id}`;
      if (requests.length) {
        this.completions.delete(session.id);
        activeAttentionGroups.add(groupKey);
        const fresh = (!this.initialized || attentionEvidence) && requests.some(request => !this.seenRequests.has(request.key));
        for (const request of requests) this.seenRequests.add(request.key);
        if (!input.visibleSessionIds.has(session.id)) {
          const first = requests[0]!;
          notifications.push({ key: requests.map(request => request.key).join("|"), groupKey,
            title: requests.length > 1 ? `${first.title} (${requests.length})` : first.title,
            message: session.title, detail: first.preview ? notificationPreview(first.preview) : undefined,
            target: first.target, kind: "attention", updateOnly: !fresh });
        }
      }
      const candidate = this.completions.get(session.id);
      if (!candidate) continue;
      const events = input.indexes.eventsBySessionId.get(session.id) ?? [];
      const latestStart = lastEvent(events, ["turn.started"]);
      if (latestStart?.turnId && candidate.event.turnId && latestStart.turnId !== candidate.event.turnId) {
        this.completions.delete(session.id); continue;
      }
      if (input.now < candidate.readyAt) {
        nextDeadline = nextDeadline === null ? candidate.readyAt : Math.min(nextDeadline, candidate.readyAt);
        continue;
      }
      if (continues(session, candidate.event, input.indexes)) continue;
      this.completions.delete(session.id);
      if (input.visibleSessionIds.has(session.id)) continue;
      notifications.push({ key: `completed:${session.id}:${candidate.event.turnId ?? candidate.event.id}`,
        groupKey: `thread-completion:${session.id}`, title: "Finished", message: session.title, kind: "completion",
        target: { sessionId: session.id, turnId: candidate.event.turnId } });
    }
    this.initialized = true;
    if (this.seenRequests.size > 10_000) this.seenRequests = new Set([...this.seenRequests].slice(-5_000));
    return { notifications, activeAttentionGroups, nextDeadline };
  }
}
