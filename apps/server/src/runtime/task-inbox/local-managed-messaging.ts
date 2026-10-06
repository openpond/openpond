import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SendLocalManagedMessageSchema, type LocalManagedMessageTarget, type Session, type TaskInput, type TaskInputAdmission, type Turn } from "@openpond/contracts";
import type { TaskInboxRepository } from "./repository.js";
import { localManagedTargetRevision } from "./target-revision.js";
import { isCodexHistorySessionId } from "../../codex-history.js";
import { LocalManagedMessageError } from "./local-managed-message-error.js";

type ManagedReadiness = { available: boolean; reason: string | null; canSteer: boolean };

/** Only attach to authenticated desktop-local routes, never background model tools. */
export function createLocalManagedMessaging(deps: {
  store: TaskInboxRepository;
  getSession(sessionId: string): Promise<Session | null>;
  latestTurn(sessionId: string): Promise<Turn | null>;
  readiness(session: Session): Promise<ManagedReadiness>;
  approvalBlocked(sessionId: string): Promise<boolean>;
  admit(input: TaskInputAdmission): Promise<TaskInput>;
}) {
  async function inspect(sessionId: string): Promise<LocalManagedMessageTarget> {
    const session = await deps.getSession(sessionId);
    if (!session) throw new LocalManagedMessageError("This task no longer exists. Choose an available task before sending.", 404);
    const [inbox, turn, ready, approvalBlocked] = await Promise.all([
      deps.store.taskInboxSnapshot(sessionId), deps.latestTurn(sessionId), deps.readiness(session), deps.approvalBlocked(sessionId),
    ]);
    const managedSessionId = session.provider === "codex" ? session.codexThreadId : session.nativeAgent?.sessionId ?? null;
    const supported = ["codex", "claude-code", "opencode", "grok-build"].includes(session.provider);
    const qualifiedHistory = session.metadata?.nativeResumeAvailable === true && !session.metadata?.nativeBranch
      && session.nativeAgent?.provider === session.provider && session.nativeAgent.cwd === session.cwd;
    const unavailableReason = session.archived || session.status === "closed" ? "This task is closed or archived."
      : session.workspaceKind === "sandbox" || session.workspaceKind === "sandbox_template" || session.workspaceKind === "sandbox_app" ? "This target is hosted; use its hosted message action."
      : (session.metadata?.nativeHistoryProjection === true && !qualifiedHistory) || isCodexHistorySessionId(session.id) ? "This imported conversation has not been qualified for original-session continuation. Open it in the desktop and check its connection before sending a task follow-up."
      : !supported || !managedSessionId ? "This conversation has no managed local session. Imported history alone cannot receive messages."
      : !ready.available ? ready.reason ?? "The original managed agent is unavailable."
      : null;
    const targetRevision = localManagedTargetRevision(session, turn?.id ?? null);
    return { sessionId, provider: session.provider, title: session.title, managedSessionId, targetRevision,
      latestTurnId: turn?.id ?? null, activeTurnId: inbox.activeTurnId, paused: inbox.paused, approvalBlocked,
      canSendFollowup: unavailableReason === null,
      canSteer: unavailableReason === null && ready.canSteer && inbox.acceptingInput && !approvalBlocked,
      unavailableReason, inbox };
  }

  async function send(sessionId: string, payload: unknown): Promise<TaskInput> {
    const input = SendLocalManagedMessageSchema.parse(payload);
    const admissionPayload = { localManagedMessage: { targetRevision: input.expectedTargetRevision,
      recommendationId: input.recommendationId ?? null, authority: input.authority } };
    const kind = input.mode === "steer" ? "steer" : "queued";
    // Lookup precedes revision checks: an acknowledged retry must remain the same
    // receipt after the first click started or finished its follow-up turn.
    let previous: TaskInput | undefined;
    let afterSequence = 0;
    while (!previous) {
      const page = await deps.store.taskInputsForSession(sessionId, { afterSequence, limit: 500 });
      previous = page.find((receipt) => receipt.senderKind === "user" && receipt.senderSessionId === null
        && receipt.idempotencyKey === input.idempotencyKey);
      if (page.length < 500) break;
      afterSequence = page.at(-1)!.sequence;
    }
    if (previous) {
      const receiptIntent = previous.payload.localManagedMessage;
      if (previous.kind !== kind || previous.body !== input.prompt || previous.expectedTurnId !== (input.expectedTurnId ?? null)
        || !isDeepStrictEqual(receiptIntent, admissionPayload.localManagedMessage)) {
        throw new LocalManagedMessageError("This message identity was already used with different content or target. Refresh before sending a changed message.");
      }
      return previous;
    }
    const target = await inspect(sessionId);
    if (!target.canSendFollowup) throw new LocalManagedMessageError(target.unavailableReason!, 422);
    if (target.targetRevision !== input.expectedTargetRevision) throw new LocalManagedMessageError("The managed target changed. Refresh and review the message before sending.");
    if (input.mode === "steer" && (!target.canSteer || target.activeTurnId !== input.expectedTurnId)) {
      throw new LocalManagedMessageError("The observed turn is no longer accepting corrections. Your text was not sent to another turn; refresh or queue a follow-up.");
    }
    return deps.admit({ id: randomUUID(), sessionId, senderSessionId: null, senderKind: "user", kind,
      body: input.prompt, payload: admissionPayload, idempotencyKey: input.idempotencyKey,
      expectedTurnId: input.expectedTurnId ?? null, replyTo: null });
  }

  return { inspect, send };
}
