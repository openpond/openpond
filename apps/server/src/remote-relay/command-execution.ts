import { z } from "zod";
import type { RemoteDeviceFrame, RemoteDispatchCommand } from "@openpond/contracts";
import type { RemoteRelayDependencies } from "./manager-types.js";

type CommandJob = {
  commandId: string;
  payloadHash: string;
  current(): boolean;
  run(): Promise<void>;
  failed(error: unknown): void;
  release(): void;
};

/** Commands keep their order without blocking cancellation or lease renewal. */
export function createRemoteCommandExecution() {
  let pending: CommandJob[] = [];
  let active: Promise<void> | null = null;
  let activeJob: CommandJob | null = null;
  let closed = false;

  function advance() {
    if (closed || active) return;
    const job = pending.shift();
    if (!job) return;
    activeJob = job;
    active = Promise.resolve().then(async () => {
      try {
        if (job.current()) await job.run();
      } catch (error) {
        try { job.failed(error); }
        catch { /* Reporting failures cannot strand the lane or its byte budget. */ }
      } finally {
        job.release();
      }
    }).finally(() => {
      active = null;
      activeJob = null;
      advance();
    });
  }

  return {
    contains(commandId: string, payloadHash: string) {
      const matching = [...(activeJob ? [activeJob] : []), ...pending]
        .filter(job => job.commandId === commandId);
      if (matching.some(job => job.payloadHash !== payloadHash))
        throw new Error("remote_command_identity_changed");
      return matching.length > 0;
    },
    enqueue(job: CommandJob) {
      if (closed || !job.current()) { job.release(); return; }
      pending.push(job);
      advance();
    },
    invalidate() {
      pending = pending.filter(job => {
        if (job.current()) return true;
        job.release();
        return false;
      });
    },
    async close() {
      closed = true;
      for (const job of pending) job.release();
      pending = [];
      // Authority is revoked by the owner before this wait. An active command
      // may still finish persisting its original admitted input's receipt.
      await active;
    },
  };
}

/** Replies belong to the connection that delivered the command. */
export async function executeRemoteCommand(input: {
  command: RemoteDispatchCommand;
  deps: Pick<RemoteRelayDependencies, "execute" | "store">;
  send(frame: RemoteDeviceFrame): void;
}) {
  const { command, deps, send } = input;
  try {
    const receipt = await deps.execute(command);
    send({ protocolVersion: 1, type: "receipt", payload: receipt });
  } catch (error) {
    const admitted = await deps.store.getRemoteDeviceReceipt(command.id);
    if (admitted) {
      send({ protocolVersion: 1, type: "receipt", payload: { ...admitted, state: "reconciling" } });
      return;
    }
    send({ protocolVersion: 1, type: "receipt", payload: {
      id: command.id, deviceId: command.deviceId, payloadHash: command.payloadHash,
      action: command.action, targetId: command.targetId, state: "rejected", revision: 2,
      error: error instanceof z.ZodError ? "remote_command_configuration_invalid"
        : error instanceof Error && /^remote_[a-z0-9_]+$/.test(error.message) ? error.message : "remote_command_failed",
      createdAt: new Date().toISOString(), expiresAt: command.deadline,
    } });
  }
}

/** Receipt queries capture pending execution before asynchronous SQLite reads. */
export async function readRemoteCommandReceiptQuery(options: {
  request: { commandId: string; payloadHash: string };
  requestId: RemoteDeviceFrame["requestId"];
  store: RemoteRelayDependencies["store"];
  pending(commandId: string, payloadHash: string): boolean;
  current(): boolean;
}): Promise<RemoteDeviceFrame | null> {
  const { request, requestId, store, pending, current } = options;
  // Capture before SQLite reads: an active job may commit and settle
  // while those reads still return their earlier absent input/receipt.
  const pendingExecution = pending(request.commandId, request.payloadHash);
  const receipt = await store.getRemoteDeviceReceipt(
    request.commandId,
  );
  if (!current()) return null;
  const input = await store.getTaskInput(
    `remote-input:${request.commandId}`,
  );
  if (!current()) return null;
  const admitted = input?.payload.remoteDevice as
    | RemoteDispatchCommand
    | undefined;
  const cancellation = await store.getRemoteDeviceCancellation(
    request.commandId,
  );
  if (!current()) return null;
  if (cancellation && cancellation.payload_hash !== request.payloadHash)
    throw new Error("remote_command_identity_changed");
  if (
    (receipt && receipt.payloadHash !== request.payloadHash) ||
    (admitted && admitted.payloadHash !== request.payloadHash)
  )
    throw new Error("remote_command_identity_changed");
  return {
    protocolVersion: 1,
    type: "receipt_query_result",
    requestId,
    payload: {
      commandId: request.commandId,
      payloadHash: request.payloadHash,
      receipt:
        receipt ??
        (input && admitted
          ? {
              id: admitted.id,
              deviceId: admitted.deviceId,
              state: "admitted",
              revision: 2,
              payloadHash: admitted.payloadHash,
              action: admitted.action,
              targetId: admitted.targetId,
              localSessionId: input.sessionId,
              inputId: input.id,
              turnId: input.turnId,
              createdAt: input.createdAt,
              expiresAt: admitted.deadline,
            }
          : null),
      notAdmitted: !receipt && !input && !pendingExecution,
      cancelled: !!cancellation,
    },
  };
}
