import { createHash } from "node:crypto";
import { canonicalRequestContent, type Session } from "@openpond/contracts";

export type LocalSessionReservationIdentity = {
  operationId: string;
  payloadHash: string;
  creationHash: string;
  sessionRevision?: string;
  executionRevision?: string;
};

// This protected metadata key predates the shared service. Retaining it preserves
// outstanding reservations without migrating, recreating, or rebinding tasks.
export function localSessionReservationMetadata(identity: LocalSessionReservationIdentity) {
  return { ponderDesktopReservation: identity };
}

export function readLocalSessionReservation(session: Session): LocalSessionReservationIdentity | null {
  const identity = session.metadata?.ponderDesktopReservation;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const value = identity as Record<string, unknown>;
  if (typeof value.operationId !== "string" || typeof value.payloadHash !== "string"
    || typeof value.creationHash !== "string") return null;
  return value as LocalSessionReservationIdentity;
}

export function localSessionCreationHash(payload: unknown) {
  return createHash("sha256").update(canonicalRequestContent("POST", "/local/session", payload)).digest("hex");
}
