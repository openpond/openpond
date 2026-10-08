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
