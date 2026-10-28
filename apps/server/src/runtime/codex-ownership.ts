import { isDeepStrictEqual } from "node:util";
import { SendTurnRequestSchema } from "@openpond/contracts";
import type { SendTurnRequest, Session, RuntimeEvent, TaskInput, Turn } from "@openpond/contracts";
import { event } from "../utils.js";

export class CodexOwnershipError extends Error {
  constructor(
    readonly threadId: string,
    cause: unknown,
  ) {
    super(
      "Another Codex session owns this chat. Resume in OpenPond to check ownership, or release the chat from the owning Codex session first. Your message is saved here for retry.",
      { cause },
    );
    this.name = "CodexOwnershipError";
  }
}

function recoveryPayload({ metadata, ...request }: SendTurnRequest) {
  const { taskInputId: _taskInputId, ...context } = metadata ?? {};
  return { ...request, metadata: Object.keys(context).length ? context : undefined };
}

/** Only retain a request rejected before the native turn was started. */
export async function retainCodexRecoveryInput(input: {
  turn: Turn;
  request: SendTurnRequest;
  pending(): Promise<TaskInput[]>;
  queue(request: SendTurnRequest, key: string): Promise<TaskInput>;
}): Promise<{ inputId: string; revision: number }> {
  const existing = (await input.pending()).find(
    (receipt) =>
      receipt.senderKind === "user" &&
      receipt.kind === "queued" &&
      receipt.state === "pending" &&
      receipt.body === input.request.prompt &&
      (typeof input.request.metadata?.taskInputId !== "string" ||
        receipt.id === input.request.metadata.taskInputId) &&
      (() => {
        const saved = SendTurnRequestSchema.safeParse(receipt.payload);
        return (
          saved.success &&
          isDeepStrictEqual(recoveryPayload(saved.data), recoveryPayload(input.request))
        );
      })(),
  );
  const receipt =
    existing ?? (await input.queue(input.request, `codex-ownership:${input.turn.id}`));
  return { inputId: receipt.id, revision: receipt.revision };
}

export async function failTurnWithCodexRecovery(input: {
  error: unknown;
  nativeStarted: boolean;
  session: Session;
  turn: Turn;
  request: SendTurnRequest;
  pending(): Promise<TaskInput[]>;
  queue(request: SendTurnRequest, key: string): Promise<TaskInput>;
  save(marker: { inputId: string; revision: number }): Promise<unknown>;
  append(value: RuntimeEvent): Promise<void>;
  fail(): Promise<Turn>;
  onFailed(turn: Turn): Promise<void>;
}): Promise<Turn> {
  let marker: { inputId: string; revision: number } | null = null;
  if (
    input.error instanceof CodexOwnershipError &&
    !input.nativeStarted &&
    !input.session.subagentRunId &&
    !input.session.systemKind
  ) {
    try {
      marker = await retainCodexRecoveryInput(input);
      await input.save(marker);
    } catch (cause) {
      marker = null;
      await input.append(
        event({
          sessionId: input.session.id,
          turnId: input.turn.id,
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: String(cause),
          data: { phase: "codex_recovery_retention" },
        }),
      );
    }
  }
  const failed = await input.fail();
  if (marker)
    await input.append(
      event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "diagnostic",
        source: "server",
        data: { kind: "codex_ownership_recovery", ...marker },
      }),
    );
  await input.onFailed(failed);
  return failed;
}
