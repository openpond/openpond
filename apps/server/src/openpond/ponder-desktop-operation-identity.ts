import { createHash } from "node:crypto";
import { ponderDesktopRequestContent, type PonderDesktopOperation } from "@openpond/contracts";

function payloadHash(path: string, value: unknown) {
  return createHash("sha256")
    .update(ponderDesktopRequestContent("POST", path, value))
    .digest("hex");
}

export function assertPonderDesktopOperationIdentity(operation: PonderDesktopOperation) {
  const expected = `ponder-desktop-op:${createHash("sha256")
    .update(
      JSON.stringify([
        operation.origin.scope.bindingId,
        operation.origin.originChatTurnId,
        payloadHash("/ponder/desktop/intent", operation.intent),
        ...(operation.origin.humanControlId ? [operation.origin.humanControlId] : []),
      ]),
    )
    .digest("hex")}`;
  if (
    operation.id !== expected ||
    operation.payloadHash !==
      payloadHash("/ponder/desktop/operation", {
        origin: operation.origin,
        intent: operation.intent,
        target: operation.target,
      })
  )
    throw new Error("ponder_desktop_operation_identity_invalid");
}

export function ponderDesktopReservedSessionId(operationId: string) {
  return `ponder-desktop-${createHash("sha256").update(operationId).digest("hex")}`;
}
