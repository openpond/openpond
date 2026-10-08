import { z } from "zod";
import type { PonderDesktopScope } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { createWorkOutputService } from "../work/work-output-service.js";
import { PonderDesktopInputSchema } from "../store/ponder-desktop-input.js";
import {
  ponderOwnsLocalSession,
  type PonderLocalOwner,
} from "./ponder-local-scope.js";

const RequestSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    outputId: z.string().min(1).max(200),
  })
  .strict();

/** Only frozen results from this binding can expose bytes from the original local task. */
export async function readPonderDesktopOutput(
  deps: {
    store: SqliteStore;
    owner: PonderLocalOwner;
    scope: PonderDesktopScope;
    readOutput: ReturnType<typeof createWorkOutputService>["readWorkOutput"];
  },
  payload: unknown,
) {
  const request = RequestSchema.parse(payload);
  const result = await deps.store.getPonderDesktopResult(
    request.operationId,
    request.turnId,
  );
  const output = result?.outputs.find((value) => value.id === request.outputId);
  if (!result || !output) throw new Error("ponder_desktop_output_unavailable");
  const input = await deps.store.getTaskInput(
    `ponder-input:${request.operationId}`,
  );
  const accepted =
    input?.senderKind === "ponder"
      ? PonderDesktopInputSchema.parse(input.payload.ponderDesktop).operation
      : null;
  const observation = accepted
    ? null
    : await deps.store.getPonderDesktopObservation(request.operationId);
  const operation = accepted ?? observation?.operation;
  const sourceSession = input?.sessionId ?? observation?.receipt.sessionId;
  const sourceTurn = input?.turnId ?? observation?.receipt.turnId;
  if (
    !operation ||
    operation.payloadHash !== result.payloadHash ||
    sourceSession !== result.sessionId ||
    sourceTurn !== result.turnId ||
    (Object.keys(deps.scope) as Array<keyof PonderDesktopScope>).some(
      (key) => operation.origin.scope[key] !== deps.scope[key],
    )
  ) {
    throw new Error("ponder_desktop_output_authority_changed");
  }
  const session = await deps.store.getSession(result.sessionId);
  const turn = await deps.store.getTurn(result.turnId);
  if (
    !session ||
    !ponderOwnsLocalSession(session, deps.owner) ||
    !turn ||
    turn.sessionId !== session.id
  )
    throw new Error("ponder_desktop_output_owner_changed");
  const saved = await deps.readOutput({ session, outputId: output.id });
  const ref = saved.outputRef;
  if (
    ref.id !== output.id ||
    ref.sourceTaskId !== session.id ||
    ref.sourceTurnId !== turn.id ||
    ref.contentType !== output.contentType ||
    ref.sizeBytes !== output.sizeBytes ||
    ref.sha256 !== output.sha256
  ) {
    throw new Error("ponder_desktop_output_result_changed");
  }
  return {
    filename:
      // Strip path separators and control bytes from the suggested filename.
      // eslint-disable-next-line no-control-regex
      output.title.replace(/[/\\\x00-\x1f\x7f]/g, "_").slice(0, 200) ||
      "download",
    contentType: output.contentType,
    contentsBase64: saved.contentsBase64,
    sizeBytes: output.sizeBytes,
    sha256: output.sha256,
  };
}
