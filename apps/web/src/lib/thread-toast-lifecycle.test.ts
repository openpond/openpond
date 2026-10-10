import { describe, expect, it } from "vitest";
import { SessionSchema, SessionUserQuestionSchema, ApprovalSchema, type RuntimeEvent } from "@openpond/contracts";
import { RuntimeEventStore } from "./runtime-event-store";
import { buildRuntimeIndexes } from "./runtime-indexes";
import { ThreadNotificationProjector } from "./thread-notifications";
import { enqueueAppToast, type AppToast } from "./app-toasts";
import { ToastLifecycle } from "./toast-lifecycle";

const session = SessionSchema.parse({ id: "thread-a", provider: "openpond", title: "Background work", appId: null,
  appName: null, cwd: null, codexThreadId: null, createdAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-10T10:00:00Z",
  status: "idle", pinned: false, archived: false, order: 0 });
function event(name: RuntimeEvent["name"], sequence: number, data?: unknown): RuntimeEvent {
  return { id: `event-${sequence}`, sequence, name, sessionId: session.id, turnId: "turn-a", timestamp: "2026-10-10T10:00:00Z", data };
}
const question = SessionUserQuestionSchema.parse({ id: "question-a", sessionId: session.id, turnId: "turn-a", toolCallId: "tool-a",
  question: "Choose a destination?", status: "pending", answer: null, createdAt: "2026-10-10T10:00:00Z", answeredAt: null });
function state(events: RuntimeEvent[], now = 1000, visible = new Set<string>()) {
  return { sessions: [session], indexes: buildRuntimeIndexes(events, []), visibleSessionIds: visible, now };
}
function toast(id: number, createdAt: number): AppToast { return { id, createdAt, message: `Thread ${id}`, tone: "info" }; }

// One reconnect/lifecycle boundary: false completion, replayed questions and stale
// timers would otherwise send users to old work or remove a different notification.
describe("thread notification lifecycle", () => {
  it("uses live evidence once, never history loads, and waits for current work to settle", () => {
    const store = new RuntimeEventStore();
    const projector = new ThreadNotificationProjector(10);
    store.subscribeLive(batch => projector.ingest(batch, 0));
    const started = event("turn.started", 11);
    const completed = event("turn.completed", 12);
    store.mergeBootstrap([event("turn.completed", 9)]);
    expect(projector.reconcile(state(store.getAllEvents())).notifications).toEqual([]);
    store.appendLive([started, completed]);
    expect(projector.reconcile(state(store.getAllEvents(), 200)).notifications).toEqual([]);
    expect(projector.reconcile(state(store.getAllEvents())).notifications).toMatchObject([{ kind: "completion", target: { turnId: "turn-a" } }]);
    store.appendLive([completed]);
    expect(projector.reconcile(state(store.getAllEvents())).notifications).toEqual([]);
    store.append([event("user_question.asked", 2, { question })]);
    expect(projector.reconcile(state(store.getAllEvents())).notifications.every(item => item.updateOnly)).toBe(true);

    const continuation = new ThreadNotificationProjector(0);
    const next = [started, completed, { ...event("turn.started", 13), turnId: "turn-b" }];
    continuation.ingest(next, 0);
    expect(continuation.reconcile(state(next)).notifications).toEqual([]);
    const goalEngine = new ThreadNotificationProjector(0);
    const activeGoal = [...next.slice(0, 2), event("diagnostic", 14, { kind: "thread_goal", provider: "codex", goal: { objective: "Keep working", status: "active" } })];
    goalEngine.ingest(activeGoal, 0);
    expect(goalEngine.reconcile(state(activeGoal)).notifications).toEqual([]);
    const settled = [...activeGoal, event("diagnostic", 15, { kind: "thread_goal", provider: "codex", goal: { objective: "Keep working", status: "complete" } })];
    goalEngine.ingest([settled[3]!], 1000);
    expect(goalEngine.reconcile(state(settled)).notifications).toMatchObject([{ kind: "completion" }]);
  });

  it("coalesces pending input and ignores resolved batches, visible threads and failed work", () => {
    const engine = new ThreadNotificationProjector(0);
    const asked = event("user_question.asked", 1, { question });
    const answered = event("user_question.answered", 2, { resolution: { questionId: question.id, action: "answer", text: "Here" } });
    engine.ingest([asked, answered], 0);
    expect(engine.reconcile(state([asked, answered])).notifications).toEqual([]);
    const newQuestion = { ...question, id: "question-b" };
    const newAsked = event("user_question.asked", 3, { question: newQuestion });
    engine.ingest([newAsked], 0);
    const notification = engine.reconcile(state([asked, answered, newAsked])).notifications;
    expect(notification).toMatchObject([{ kind: "attention", updateOnly: false, target: { questionId: "question-b" } }]);
    expect(engine.reconcile(state([asked, answered, newAsked])).notifications[0]?.updateOnly).toBe(true);
    expect(engine.reconcile(state([newAsked], 1000, new Set([session.id]))).notifications).toEqual([]);
    const approval = ApprovalSchema.parse({ id: "input-a", sessionId: session.id, turnId: "turn-a", kind: "user_input", title: "Input",
      detail: "private arguments", status: "pending", providerRequestId: "native-agent:a", createdAt: session.createdAt });
    const indexes = buildRuntimeIndexes([newAsked], [approval]);
    const combined = engine.reconcile({ ...state([newAsked]), indexes }).notifications[0]!;
    expect(combined.target.questionId).toBe("question-b");
    expect(combined.detail).not.toContain("private");
    expect(combined.key).toContain("input-a");
    const failed = event("turn.failed", 4);
    engine.ingest([failed], 0);
    expect(engine.reconcile(state([failed])).activeAttentionGroups.size).toBe(0);
    expect(engine.reconcile(state([failed])).notifications).toEqual([]);
    expect(new ThreadNotificationProjector(4).reconcile(state([failed])).notifications).toEqual([]);

    // Stream events can precede their sidebar shell; retain that live evidence.
    const delayedShell = new ThreadNotificationProjector(0);
    delayedShell.reconcile({ ...state([]), sessions: [] });
    delayedShell.ingest([newAsked], 0);
    delayedShell.reconcile({ ...state([newAsked]), sessions: [] });
    expect(delayedShell.reconcile(state([newAsked])).notifications[0]?.updateOnly).toBe(false);
  });

  it("keeps independent five-second clocks while arrivals push down, pause, park and resume", () => {
    const clock = new ToastLifecycle();
    const a = toast(1, 0), b = toast(2, 1000), c = toast(3, 2000), d = toast(4, 2500);
    clock.sync([a], 0); clock.tick(300);
    clock.sync([b, a], 1000); clock.tick(1300);
    expect(clock.snapshot().map(card => card.toast.id)).toEqual([2, 1]);
    expect(clock.tick(5300)).toEqual([1]);
    expect(clock.snapshot().find(card => card.toast.id === 2)?.phase).toBe("visible");
    expect(clock.tick(6300)).toEqual([2]);

    const parked = new ToastLifecycle();
    parked.sync([a], 0); parked.tick(300);
    parked.sync([b, a], 1000); parked.tick(1300);
    parked.sync([c, b, a], 2000); parked.tick(2300);
    parked.sync([d, c, b, a], 2500); parked.tick(2800);
    expect(parked.snapshot().find(card => card.toast.id === 1)?.parked).toBe(true);
    parked.sync([c, b, a], 3000);
    expect(parked.snapshot().find(card => card.toast.id === 1)?.parked).toBe(false);
    // A had 2.2s visible before parking, so it gets its remaining 2.8s.
    expect(parked.tick(5800)).toEqual([1]);
    parked.pause(2, true, 5800);
    expect(parked.tick(10_000)).not.toContain(2);
    parked.pause(2, false, 10_000);
    expect(parked.tick(10_500)).toContain(2);

    const focused = new ToastLifecycle();
    focused.sync([c, b, a], 2000); focused.tick(2300);
    focused.pause(1, true, 2400);
    focused.sync([d, c, b, a], 2500);
    expect(focused.snapshot().find(card => card.toast.id === 1)?.parked).toBe(false);
    expect(focused.snapshot().find(card => card.toast.id === 4)?.parked).toBe(true);
    focused.pause(1, false, 3000);
    expect(focused.snapshot().find(card => card.toast.id === 4)?.parked).toBe(false);
  });

  it("bounds bursts, deduplicates updates and never clears another ID on stale dismissal", () => {
    let items: AppToast[] = [];
    for (let id = 0; id < 40; id++) items = enqueueAppToast(items, toast(id, id));
    expect(items).toHaveLength(23);
    expect(items[0]?.id).toBe(39);
    const duplicate = { ...toast(50, 50), dedupeKey: "same" };
    items = enqueueAppToast(items, duplicate);
    expect(enqueueAppToast(items, { ...duplicate, id: 51 })).toBe(items);
    const clock = new ToastLifecycle();
    clock.sync(items, 100); clock.dismiss(999, 100);
    expect(clock.snapshot().filter(item => !item.parked)).toHaveLength(3);
  });
});
