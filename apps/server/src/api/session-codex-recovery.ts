import {
  CodexRecoveryRequestSchema,
  type CodexRecoveryResponse,
  type Session,
  type Turn,
  type TaskInput,
  type RuntimeEvent,
} from "@openpond/contracts";
import { CodexAppServerClient } from "@openpond/codex-provider";
import { assertNativeWorkerDirectInput } from "../runtime/native-worker-capabilities.js";
import { event } from "../utils.js";
import { loadCodexHistoryFileIndex } from "../codex-history-file-index.js";
import { codexHomePath } from "../codex-history-utils.js";

type RecoveryClient = Pick<CodexAppServerClient, "resumeThread" | "unarchiveThread" | "stop">;

/** Recovery only retries a durable, unchanged user input that never reached Codex. */
export function createSessionCodexRecovery(deps: {
  getSession(id: string): Promise<Session>;
  getTurn(id: string): Promise<Turn | null>;
  latestTurn(id: string): Promise<Turn | null>;
  getInput(id: string): Promise<TaskInput | null>;
  activeTurnId(id: string): Promise<string | null>;
  ownsWriter(session: Session): boolean;
  interrupt(id: string, expectedTurnId: string): Promise<unknown>;
  waitForSettlement(id: string): Promise<void>;
  resume(id: string, input: TaskInput): Promise<unknown>;
  append(value: RuntimeEvent): Promise<void>;
  createClient?: () => RecoveryClient;
  isArchived?: (threadId: string) => Promise<boolean>;
}) {
  const pending = new Map<string, Promise<CodexRecoveryResponse>>();
  return async (sessionId: string, payload: unknown): Promise<CodexRecoveryResponse> => {
    const request = CodexRecoveryRequestSchema.parse(payload);
    const key = JSON.stringify([sessionId, request]);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = recover();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }

    async function recover(): Promise<CodexRecoveryResponse> {
      const session = await deps.getSession(sessionId);
      assertNativeWorkerDirectInput(session);
      if (
        session.provider !== "codex" ||
        !session.codexThreadId ||
        session.archived ||
        session.systemKind ||
        session.subagentRunId
      ) {
        throw new Error("This chat cannot use Codex ownership recovery.");
      }
      const failed = await deps.getTurn(request.failedTurnId);
      if (
        !failed ||
        failed.sessionId !== sessionId ||
        failed.status !== "failed" ||
        failed.providerTurnId
      ) {
        throw new Error("This turn is not an unstarted request in this chat.");
      }
      const marker = failed.metadata.codexRecovery as
        | { inputId?: unknown; revision?: unknown }
        | undefined;
      if (!marker || typeof marker.inputId !== "string" || typeof marker.revision !== "number") {
        throw new Error("This turn has no saved ownership recovery request.");
      }
      async function savedInput() {
        const input = await deps.getInput(marker!.inputId as string);
        return input?.sessionId === sessionId &&
          input.senderKind === "user" &&
          input.kind === "queued" &&
          input.state === "pending" &&
          input.turnId === null &&
          input.revision === marker!.revision &&
          input.body === failed!.prompt
          ? input
          : null;
      }
      if (!(await savedInput())) return { state: "superseded" };
      const active = await deps.activeTurnId(sessionId);
      if (active) {
        if (request.confirmedActiveTurnId !== active)
          return { state: "active", activeTurnId: active };
        // The interruption runtime checks this exact ID before touching a writer.
        await deps.interrupt(sessionId, active);
        await deps.waitForSettlement(sessionId);
      } else if ((await deps.latestTurn(sessionId))?.id !== failed.id) {
        return { state: "superseded" };
      }

      if (!deps.ownsWriter(session)) {
        const client =
          deps.createClient?.() ??
          new CodexAppServerClient({
            binaryPath: process.env.CODEX_BINARY || "codex",
            clientName: "openpond-recovery",
            clientTitle: "OpenPond ownership recovery",
          });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const archived = deps.isArchived
            ? await deps.isArchived(session.codexThreadId)
            : (await loadCodexHistoryFileIndex(codexHomePath())).find(
                (file) => file.threadId === session.codexThreadId,
              )?.archived;
          if (archived === undefined)
            throw new Error(
              "This native chat's saved history is unavailable. Open it in Codex to check its location before retrying.",
            );
          await Promise.race([
            (async () => {
              // Archiving in the owning app releases its writer. Unarchive via
              // this client without reopening the chat in that other app.
              if (archived) await client.unarchiveThread(session.codexThreadId!);
              await client.resumeThread({
                threadId: session.codexThreadId!,
                cwd: session.cwd,
                approvalPolicy: "never",
                sandbox: "read-only",
              });
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("Ownership check timed out. Retry when Codex is available.")),
                20_000,
              );
            }),
          ]);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          await deps.append(
            event({
              sessionId,
              turnId: failed.id,
              name: "diagnostic",
              source: "provider",
              status: "failed",
              output: detail,
              data: { phase: "codex_ownership_check", threadId: session.codexThreadId },
            }),
          );
          if (detail.includes("already has an active writer"))
            return { state: "external", threadId: session.codexThreadId };
          throw cause;
        } finally {
          clearTimeout(timer);
          await client.stop();
        }
      }
      // Recheck after the provider round trip; an edit or another send invalidates the action.
      const input = await savedInput();
      if (!input) return { state: "superseded" };
      const nextActive = await deps.activeTurnId(sessionId);
      if (nextActive) return { state: "active", activeTurnId: nextActive };
      if ((await deps.latestTurn(sessionId))?.id !== (active ?? failed.id))
        return { state: "superseded" };
      await deps.resume(sessionId, input);
      return { state: "resumed" };
    }
  };
}
