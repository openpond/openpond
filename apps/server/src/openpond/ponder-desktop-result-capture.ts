import {
  PonderDesktopResultSchema,
  type PonderDesktopOperation,
  type FileOutputRef,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { PonderDesktopInputSchema } from "../store/ponder-desktop-input.js";
import { assertPonderDesktopOperationIdentity } from "./ponder-desktop-operation-identity.js";

export function createPonderDesktopResultCapture(deps: {
  store: Pick<
    SqliteStore,
    | "getTaskInput"
    | "getTurn"
    | "getSession"
    | "runtimeEventsForTurn"
    | "getPonderDesktopResult"
    | "commitPonderDesktopResult"
    | "getPonderDesktopObservation"
  >;
  outputs(sessionId: string, turnId: string): Promise<FileOutputRef[]>;
}) {
  return async (operation: PonderDesktopOperation) => {
    assertPonderDesktopOperationIdentity(operation);
    if (operation.intent.action === "stop" || operation.intent.action === "inspect") return null;
    let inputId: string | null;
    let turnId: string;
    let sessionId: string;
    if (operation.intent.action === "observe") {
      const observation = await deps.store.getPonderDesktopObservation(operation.id);
      if (!observation?.receipt.turnId) return null;
      if (observation.operation.payloadHash !== operation.payloadHash)
        throw new Error("ponder_desktop_result_observation_changed");
      inputId = null;
      turnId = observation.receipt.turnId;
      sessionId = observation.receipt.sessionId;
    } else {
      const input = await deps.store.getTaskInput(`ponder-input:${operation.id}`);
      if (!input?.turnId || input.senderKind !== "ponder") return null;
      const accepted = PonderDesktopInputSchema.parse(input.payload.ponderDesktop);
      if (accepted.operation.payloadHash !== operation.payloadHash)
        throw new Error("ponder_desktop_result_input_changed");
      inputId = input.id;
      turnId = input.turnId;
      sessionId = input.sessionId;
    }
    const existing = await deps.store.getPonderDesktopResult(operation.id, turnId);
    if (existing) return existing;
    const turn = await deps.store.getTurn(turnId);
    if (!turn || turn.sessionId !== sessionId || turn.status === "in_progress" || !turn.completedAt)
      return null;
    const session = await deps.store.getSession(sessionId);
    if (!session) throw new Error("ponder_desktop_result_session_missing");
    const events = await deps.store.runtimeEventsForTurn(turn.id, { names: ["assistant.delta"] });
    const messages = new Map<string, string>();
    let ordinary = "";
    const eventIds: string[] = [];
    for (const event of events) {
      if (!event.output) continue;
      const data = event.data as Record<string, unknown> | undefined;
      if (
        data?.retainedHistory === true ||
        data?.phase === "commentary" ||
        data?.phase === "reasoning"
      )
        continue;
      eventIds.push(event.id);
      const key =
        typeof data?.nativeMessageId === "string"
          ? data.nativeMessageId
          : typeof data?.itemId === "string"
            ? data.itemId
            : null;
      if (key)
        messages.set(
          key,
          data?.nativeMessageSnapshot === true
            ? event.output
            : `${messages.get(key) ?? ""}${event.output}`,
        );
      else ordinary += event.output;
    }
    const body = [ordinary, ...messages.values()].filter(Boolean).join("\n\n");
    const outputs = (await deps.outputs(session.id, turn.id))
      .filter((output) => output.sourceTaskId === session.id && output.sourceTurnId === turn.id)
      .map(({ id, title, contentType, sizeBytes, sha256 }) => ({
        id,
        title,
        contentType,
        sizeBytes,
        sha256,
      }));
    const result = PonderDesktopResultSchema.parse({
      operationId: operation.id,
      payloadHash: operation.payloadHash,
      sessionId: session.id,
      sessionTitle: session.title.slice(0, 300),
      inputId,
      turnId: turn.id,
      completedAt: new Date(turn.completedAt).toISOString(),
      outcome: turn.status === "interrupted" ? "cancelled" : turn.status,
      body: body.slice(0, 128_000),
      bodyTruncated: body.length > 128_000,
      assistantEventIds: eventIds.slice(0, 2_000),
      providerId: turn.modelRef?.providerId ?? operation.target.providerId,
      modelId: turn.modelRef?.modelId ?? operation.target.modelId,
      workspaceId: operation.target.workspaceId,
      outputs: outputs.slice(0, 100),
      error: turn.error?.slice(0, 2_000) ?? null,
    });
    return deps.store.commitPonderDesktopResult(result);
  };
}
