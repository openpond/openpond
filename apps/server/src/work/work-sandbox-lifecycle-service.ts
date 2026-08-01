import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import type { SaveWorkOutputResult } from "./work-output-service.js";

type CleanupEntry = {
  sandboxId: string;
  sessionId: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
};

export function createWorkSandboxLifecycleService(input: {
  storeDir: string;
  saveAllWorkOutputs(request: {
    session: Session;
    sourceTurnId: string;
  }): Promise<SaveWorkOutputResult[]>;
  sandboxRequest(payload: {
    type: "delete" | "stop";
    sandboxId: string;
  }): Promise<unknown>;
  updateSession(sessionId: string, patch: Partial<Session>): Promise<Session>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}) {
  const outboxPath = path.join(
    input.storeDir,
    "work",
    "sandbox-cleanup-outbox.json"
  );
  let operation = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function finalizeTurn(request: {
    session: Session;
    turnId: string;
    outcome: "completed" | "failed" | "interrupted";
  }): Promise<Session> {
    const sandboxId =
      request.session.workspaceKind === "sandbox"
        ? request.session.workspaceId
        : null;
    if (!sandboxId) return request.session;

    let outputs: SaveWorkOutputResult[];
    try {
      outputs = await input.saveAllWorkOutputs({
        session: request.session,
        sourceTurnId: request.turnId,
      });
      for (const output of outputs) {
        await input.appendRuntimeEvent(
          lifecycleEvent({
            sessionId: request.session.id,
            turnId: request.turnId,
            action: "sandbox_save_output",
            status: "completed",
            output: `Saved ${output.outputRef.title} outside the sandbox.`,
            data: output,
          })
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      await input.sandboxRequest({ type: "stop", sandboxId }).catch(() => undefined);
      await input.appendRuntimeEvent(
        lifecycleEvent({
          sessionId: request.session.id,
          turnId: request.turnId,
          action: "work_output_persistence",
          status: "failed",
          output:
            "Work output persistence failed. Compute was stopped and retained for recovery.",
          error: message,
          data: { sandboxId, outcome: request.outcome },
        })
      );
      throw error;
    }

    let cleanupStatus: "completed" | "pending" = "completed";
    let cleanupError: string | undefined;
    try {
      await input.sandboxRequest({ type: "delete", sandboxId });
      await removeCleanup(sandboxId);
    } catch (error) {
      cleanupStatus = "pending";
      cleanupError = errorMessage(error);
      await enqueueCleanup({
        sandboxId,
        sessionId: request.session.id,
        error: cleanupError,
      });
    }

    const session = await input.updateSession(request.session.id, {
      workspaceId: null,
      workspaceName: null,
      cwd: null,
    });
    await input.appendRuntimeEvent(
      lifecycleEvent({
        sessionId: request.session.id,
        turnId: request.turnId,
        action: "work_sandbox_cleanup",
        status: cleanupStatus,
        output:
          cleanupStatus === "completed"
            ? "Deleted ephemeral Work compute."
            : "Work output is durable; sandbox deletion is queued for retry.",
        ...(cleanupError ? { error: cleanupError } : {}),
        data: {
          sandboxId,
          outcome: request.outcome,
          outputCount: outputs.length,
          cleanupStatus,
        },
      })
    );
    return session;
  }

  async function retryPending(): Promise<void> {
    await serialized(async () => {
      const now = Date.now();
      const entries = await readOutbox();
      const retained: CleanupEntry[] = [];
      for (const entry of entries) {
        if (Date.parse(entry.nextAttemptAt) > now) {
          retained.push(entry);
          continue;
        }
        try {
          await input.sandboxRequest({
            type: "delete",
            sandboxId: entry.sandboxId,
          });
          await input.appendRuntimeEvent(
            lifecycleEvent({
              sessionId: entry.sessionId,
              action: "work_sandbox_cleanup",
              status: "completed",
              output: "Deleted ephemeral Work compute during cleanup retry.",
              data: { sandboxId: entry.sandboxId, cleanupStatus: "completed" },
            })
          );
        } catch (error) {
          const attempts = entry.attempts + 1;
          retained.push({
            ...entry,
            attempts,
            lastError: errorMessage(error),
            nextAttemptAt: new Date(
              now + Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 1_000)
            ).toISOString(),
          });
        }
      }
      await writeOutbox(retained);
    });
  }

  function start(): void {
    if (timer) return;
    void retryPending();
    timer = setInterval(() => void retryPending(), 60_000);
    timer.unref?.();
  }

  async function close(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    await operation;
  }

  async function enqueueCleanup(request: {
    sandboxId: string;
    sessionId: string;
    error: string;
  }): Promise<void> {
    await serialized(async () => {
      const entries = await readOutbox();
      const existing = entries.find(
        (entry) => entry.sandboxId === request.sandboxId
      );
      const next: CleanupEntry = {
        sandboxId: request.sandboxId,
        sessionId: request.sessionId,
        attempts: existing?.attempts ?? 0,
        nextAttemptAt: new Date().toISOString(),
        lastError: request.error,
      };
      await writeOutbox([
        ...entries.filter((entry) => entry.sandboxId !== request.sandboxId),
        next,
      ]);
    });
  }

  async function removeCleanup(sandboxId: string): Promise<void> {
    await serialized(async () => {
      const entries = await readOutbox();
      if (!entries.some((entry) => entry.sandboxId === sandboxId)) return;
      await writeOutbox(entries.filter((entry) => entry.sandboxId !== sandboxId));
    });
  }

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = operation.then(task, task);
    operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function readOutbox(): Promise<CleanupEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(outboxPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isCleanupEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeOutbox(entries: CleanupEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(outboxPath), { recursive: true, mode: 0o700 });
    const temporary = `${outboxPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, outboxPath);
  }

  return { close, finalizeTurn, retryPending, start };
}

function lifecycleEvent(input: {
  sessionId: string;
  turnId?: string;
  action: string;
  status: "completed" | "failed" | "pending";
  output: string;
  error?: string;
  data?: unknown;
}): RuntimeEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    name: "workspace_action_result",
    source: "server",
    ...input,
  };
}

function isCleanupEntry(value: unknown): value is CleanupEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<CleanupEntry>;
  return (
    typeof entry.sandboxId === "string" &&
    typeof entry.sessionId === "string" &&
    typeof entry.attempts === "number" &&
    typeof entry.nextAttemptAt === "string" &&
    typeof entry.lastError === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
