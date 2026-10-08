import { z } from "zod";
import {
  PonderDesktopAttachmentSchema,
  PonderDesktopOperationSchema,
  type PonderDesktopOperation,
  type Session,
  type TaskInputAdmission,
} from "@openpond/contracts";
import {
  ponderDesktopSessionRevision,
  ponderDesktopExecutionRevision,
} from "../openpond/ponder-desktop-catalog.js";
import { ponderOwnsLocalSession, PonderLocalOwnerSchema } from "../openpond/ponder-local-scope.js";
import {
  assertPonderDesktopOperationIdentity,
  ponderDesktopReservedSessionId,
} from "../openpond/ponder-desktop-operation-identity.js";
import type { OpenPondSqliteConnection } from "./sqlite/sqlite-driver.js";

export const PonderDesktopInputSchema = z
  .object({
    operation: PonderDesktopOperationSchema,
    sessionRevision: z.string().regex(/^[a-f0-9]{64}$/),
    executionRevision: z.string().regex(/^[a-f0-9]{64}$/),
    managedSessionId: z.string().min(1).nullable(),
  })
  .strict();

export function assertPonderDesktopExecution(
  input: Pick<TaskInputAdmission, "senderKind" | "payload">,
  session: Session,
) {
  if (input.senderKind !== "ponder") return;
  const snapshot = PonderDesktopInputSchema.parse(input.payload.ponderDesktop);
  const managedId =
    session.provider === "codex" ? session.codexThreadId : (session.nativeAgent?.sessionId ?? null);
  if (
    snapshot.executionRevision !== ponderDesktopExecutionRevision(session) ||
    (snapshot.managedSessionId !== null && snapshot.managedSessionId !== managedId)
  ) {
    throw new Error(
      "The local task's model, Profile, workspace or original agent changed before the queued instruction could run.",
    );
  }
}

export function assertPonderDesktopRecipient(
  db: OpenPondSqliteConnection,
  operation: PonderDesktopOperation,
  session: Session,
  latestTurnId: string | null,
  sessionRevision: string,
) {
  assertPonderDesktopOperationIdentity(operation);
  const intent = operation.intent;
  const authorityRow = db.get<{ payload: string }>(
    "SELECT payload FROM ponder_desktop_authority WHERE id = 1",
  );
  const authority = authorityRow
    ? PonderDesktopAttachmentSchema.parse(JSON.parse(authorityRow.payload))
    : null;
  if (
    !authority ||
    authority.state !== "attached" ||
    Date.parse(authority.leaseExpiresAt) <= Date.now() ||
    authority.epoch !== operation.claimedEpoch ||
    authority.authorizationRevision !== operation.origin.authorizationRevision ||
    !Object.entries(operation.origin.scope).every(
      ([key, value]) => authority.scope[key as keyof typeof authority.scope] === value,
    )
  ) {
    throw new Error("ponder_desktop_local_authority_changed");
  }
  if (operation.state !== "dispatching" || !operation.claimId)
    throw new Error("ponder_desktop_input_identity_invalid");
  const storedOwner = PonderLocalOwnerSchema.parse(session.metadata?.ponderLocalOwner);
  const scope = operation.origin.scope;
  if (
    !ponderOwnsLocalSession(session, {
      ...storedOwner,
      installationId: scope.installationId,
      profileId: scope.profileId,
      ownerUserId: scope.ownerUserId,
      teamId: scope.teamId,
    })
  ) {
    throw new Error("ponder_desktop_input_owner_changed");
  }
  if (intent.action !== "create" && intent.targetId !== session.id)
    throw new Error("ponder_desktop_input_target_changed");
  if (
    sessionRevision !== ponderDesktopSessionRevision(session, latestTurnId) ||
    (intent.action !== "create" && sessionRevision !== intent.targetRevision)
  ) {
    throw new Error("ponder_desktop_input_target_changed");
  }
  if (intent.action === "create") {
    if (session.id !== ponderDesktopReservedSessionId(operation.id))
      throw new Error("ponder_desktop_input_reservation_invalid");
    const reservation = session.metadata?.ponderDesktopReservation;
    if (
      !reservation ||
      typeof reservation !== "object" ||
      (reservation as Record<string, unknown>).operationId !== operation.id ||
      (reservation as Record<string, unknown>).payloadHash !== operation.payloadHash
    ) {
      throw new Error("ponder_desktop_input_reservation_invalid");
    }
  }
}

/** Runs within the recipient SQLite admission transaction, after accepted-receipt lookup. */
export function assertPonderDesktopInput(
  db: OpenPondSqliteConnection,
  input: TaskInputAdmission,
  session: Session,
  latestTurnId: string | null,
) {
  if (input.senderKind !== "ponder" && input.payload.ponderDesktop === undefined) return;
  if (input.senderKind !== "ponder" || input.senderSessionId !== null)
    throw new Error("ponder_desktop_input_authority_invalid");
  const { operation, sessionRevision } = PonderDesktopInputSchema.parse(
    input.payload.ponderDesktop,
  );
  const intent = operation.intent;
  if (
    (intent.action === "stop" || intent.action === "observe" || intent.action === "inspect") ||
    input.id !== `ponder-input:${operation.id}` ||
    input.idempotencyKey !== operation.id ||
    input.body !== intent.prompt ||
    input.replyTo !== null ||
    input.kind !== (intent.action === "steer" ? "steer" : "queued") ||
    input.expectedTurnId !== (intent.action === "steer" ? intent.expectedTurnId : null)
  ) {
    throw new Error("ponder_desktop_input_identity_invalid");
  }
  assertPonderDesktopRecipient(db, operation, session, latestTurnId, sessionRevision);
  assertPonderDesktopExecution(input, session);
}
