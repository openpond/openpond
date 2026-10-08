import { PonderDesktopInputSchema } from "../store/ponder-desktop-input.js";
import {
  ponderDesktopSessionRevision,
  ponderDesktopExecutionRevision,
} from "./ponder-desktop-catalog.js";
import {
  assertPonderDesktopOperationIdentity,
  ponderDesktopReservedSessionId,
} from "./ponder-desktop-operation-identity.js";
import type { PonderLocalOwner } from "./ponder-local-scope.js";
import type {
  PonderDesktopOperation,
  PonderDesktopReservationResume,
  Session,
  TaskInput,
  TaskInputAdmission,
  Turn,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { ReservedSessionCreation } from "../store/session-store.js";

type Receipt = NonNullable<PonderDesktopOperation["receipt"]>;

/** Canonical receipt recovery precedes mutable readiness checks. No uncertain claim is replayed. */
export function createPonderDesktopExecutor(deps: {
  store: Pick<
    SqliteStore,
    | "getTaskInput"
    | "getSession"
    | "latestTurnForSession"
    | "getTurn"
    | "admitPonderDesktopStop"
    | "getPonderDesktopStop"
    | "settlePonderDesktopStop"
    | "admitPonderDesktopObservation"
    | "getPonderDesktopObservation"
    | "admitPonderDesktopInspection"
    | "getPonderDesktopInspection"
    | "getPonderDesktopReservationResume"
  >;
  admit(input: TaskInputAdmission): Promise<TaskInput>;
  interrupt(
    sessionId: string,
    reason: string,
    expectedTurnId?: string,
  ): Promise<Turn | null>;
  resolveStarter(target: PonderDesktopOperation["target"]): Promise<unknown>;
  createReserved(
    payload: unknown,
    identity: ReservedSessionCreation,
  ): Promise<Session>;
}) {
  async function recover(
    operation: PonderDesktopOperation,
  ): Promise<Receipt | null> {
    assertPonderDesktopOperationIdentity(operation);
    if (operation.intent.action === "inspect") {
      const inspection = await deps.store.getPonderDesktopInspection(operation.id);
      if (inspection && inspection.operation.payloadHash !== operation.payloadHash)
        throw new Error("ponder_desktop_receipt_identity_changed");
      return inspection?.receipt ?? null;
    }
    if (operation.intent.action === "observe") {
      const observation = await deps.store.getPonderDesktopObservation(
        operation.id,
      );
      if (
        observation &&
        observation.operation.payloadHash !== operation.payloadHash
      )
        throw new Error("ponder_desktop_receipt_identity_changed");
      return observation?.receipt ?? null;
    }
    if (operation.intent.action === "stop") {
      const stop = await deps.store.getPonderDesktopStop(operation.id);
      if (!stop) return null;
      if (stop.operation.payloadHash !== operation.payloadHash)
        throw new Error("ponder_desktop_receipt_identity_changed");
      if (stop.receipt.state === "stop_requested") {
        // The durable stop intent is tied to one exact turn. A restart may finish
        // that intent, but must never cancel its successor.
        const turn = await deps.store.getTurn(stop.receipt.turnId!);
        if (turn?.status === "in_progress") {
          const interrupted = await deps
            .interrupt(
              stop.receipt.sessionId,
              "Stopped by Ponder at the user's request.",
              stop.receipt.turnId!,
            )
            .catch((error) => {
              if (
                error instanceof Error &&
                (error.message === "No active turn to stop." ||
                  error.message ===
                    "The expected turn is no longer active. Another turn was not stopped.")
              )
                return null;
              throw error;
            });
          return (
            await deps.store.settlePonderDesktopStop(
              operation.id,
              interrupted ? "interrupted" : "already_finished",
            )
          ).receipt;
        }
        return (
          await deps.store.settlePonderDesktopStop(
            operation.id,
            "already_finished",
          )
        ).receipt;
      }
      return stop.receipt;
    }
    const input = await deps.store.getTaskInput(`ponder-input:${operation.id}`);
    if (!input) return null;
    const accepted = PonderDesktopInputSchema.parse(
      input.payload.ponderDesktop,
    );
    if (
      accepted.operation.payloadHash !== operation.payloadHash ||
      input.senderKind !== "ponder"
    ) {
      throw new Error("ponder_desktop_receipt_identity_changed");
    }
    const session = await deps.store.getSession(input.sessionId);
    return {
      sessionId: input.sessionId,
      sessionTitle: session?.title ?? operation.target.title,
      inputId: input.id,
      turnId: input.turnId,
      state: input.state,
    };
  }

  async function execute(
    operation: PonderDesktopOperation,
    owner: PonderLocalOwner,
    resume?: PonderDesktopReservationResume,
  ): Promise<Receipt> {
    const previous = await recover(operation);
    if (previous) return previous;
    if (operation.state !== "dispatching")
      throw new Error("ponder_desktop_claim_required");
    if (operation.intent.action === "inspect") {
      return (await deps.store.admitPonderDesktopInspection(operation)).receipt;
    }
    if (operation.intent.action === "observe") {
      return (await deps.store.admitPonderDesktopObservation(operation))
        .receipt;
    }
    if (operation.intent.action === "stop") {
      await deps.store.admitPonderDesktopStop(operation);
      return (await recover(operation))!;
    }
    if (resume) {
      const current = await deps.store.getPonderDesktopReservationResume(
        operation,
        owner,
      );
      if (!current || JSON.stringify(current) !== JSON.stringify(resume))
        throw new Error("ponder_desktop_reservation_changed");
    }
    const session = resume
      ? await deps.store.getSession(resume.sessionId)
      : operation.intent.action === "create"
        ? await deps.createReserved(
            {
              ...((await deps.resolveStarter(operation.target)) as Record<
                string,
                unknown
              >),
              title: operation.intent.title,
            },
            {
              sessionId: ponderDesktopReservedSessionId(operation.id),
              operationId: operation.id,
              payloadHash: operation.payloadHash,
              owner,
              desktopOperation: operation,
            },
          )
        : await deps.store.getSession(operation.intent.targetId);
    if (!session) throw new Error("ponder_desktop_target_unavailable");
    const latest = await deps.store.latestTurnForSession(session.id);
    const receipt = await deps.admit({
      id: `ponder-input:${operation.id}`,
      sessionId: session.id,
      senderSessionId: null,
      senderKind: "ponder",
      kind: operation.intent.action === "steer" ? "steer" : "queued",
      body: operation.intent.prompt,
      idempotencyKey: operation.id,
      replyTo: null,
      expectedTurnId:
        operation.intent.action === "steer"
          ? operation.intent.expectedTurnId
          : null,
      payload: {
        ponderDesktop: {
          operation,
          sessionRevision:
            resume?.sessionRevision ??
            ponderDesktopSessionRevision(session, latest?.id ?? null),
          executionRevision:
            resume?.executionRevision ??
            ponderDesktopExecutionRevision(session),
          managedSessionId:
            session.provider === "codex"
              ? session.codexThreadId
              : (session.nativeAgent?.sessionId ?? null),
        },
      },
    });
    return {
      sessionId: session.id,
      sessionTitle: session.title,
      inputId: receipt.id,
      turnId: receipt.turnId,
      state: receipt.state,
    };
  }
  return {
    recover,
    execute,
    reservation: (operation: PonderDesktopOperation, owner: PonderLocalOwner) =>
      deps.store.getPonderDesktopReservationResume(operation, owner),
  };
}
