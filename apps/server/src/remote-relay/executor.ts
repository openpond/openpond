import type { LocalManagedMessageTarget, RemoteCommandReceipt, RemoteDispatchCommand, TaskInputAdmission, TaskInput } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { createHash } from "node:crypto";
import { DeviceLocalOwnerSchema } from "./local-scope.js";
import { remoteStarterPayload } from "./starters.js";

/** Canonical task inputs are recovery authority even when receipt upload was lost. */
export function createRemoteCommandExecutor(deps: {
  store: Pick<SqliteStore, "getTaskInput" | "getRemoteDeviceReceipt" | "saveRemoteDeviceReceipt" | "admitRemoteDeviceStop" | "getTurn" | "admitRemoteDeviceApproval" | "getApproval">;
  inspect(id: string): Promise<LocalManagedMessageTarget>;
  admit(input: TaskInputAdmission): Promise<TaskInput>;
  interrupt(sessionId: string, reason: string, expectedTurnId?: string): Promise<import("@openpond/contracts").Turn | null>;
  resolveStarter?(command: RemoteDispatchCommand): Promise<import("@openpond/contracts").Session>;
  createReserved?(payload: unknown, identity: import("../store/session-store.js").ReservedSessionCreation): Promise<import("@openpond/contracts").Session>;
  resolveApproval?(approvalId: string, payload: unknown): Promise<import("@openpond/contracts").Approval>;
}) {
  return async (command: RemoteDispatchCommand): Promise<RemoteCommandReceipt> => {
    const prior = await deps.store.getRemoteDeviceReceipt(command.id);
    if (prior && (!["stop", "approval"].includes(command.action) || prior.state !== "admitted")) {
      if (prior.payloadHash !== command.payloadHash) throw new Error("remote_command_identity_changed");
      return prior;
    }
    if (command.action === "approval") {
      if (!deps.resolveApproval || !command.payload.response) throw new Error("remote_approval_unavailable");
      const accepted = prior ?? await deps.store.admitRemoteDeviceApproval(command);
      if (accepted.payloadHash !== command.payloadHash) throw new Error("remote_command_identity_changed");
      const current = await deps.store.getApproval(accepted.approvalId!);
      if (current?.status === "pending") await deps.resolveApproval(accepted.approvalId!, { decision: command.payload.response === "approve" ? "accept" : "decline" });
      const settled = { ...accepted, state: "applied" as const, revision: accepted.revision + 1 };
      await deps.store.saveRemoteDeviceReceipt(command, settled); return settled;
    }
    if (command.action === "stop") {
      const stopped = prior ?? await deps.store.admitRemoteDeviceStop(command);
      if (stopped.payloadHash !== command.payloadHash) throw new Error("remote_command_identity_changed");
      const turn = stopped.turnId ? await deps.store.getTurn(stopped.turnId) : null;
      if (turn?.status === "in_progress") await deps.interrupt(stopped.localSessionId!, "Stopped remotely at the user's request.", stopped.turnId);
      const settled = { ...stopped, state: "applied" as const, revision: stopped.revision + 1 };
      await deps.store.saveRemoteDeviceReceipt(command, settled);
      return settled;
    }
    const receipt: RemoteCommandReceipt = { id: command.id, deviceId: command.deviceId, state: "admitted", revision: 2,
      payloadHash: command.payloadHash, action: command.action, targetId: command.targetId,
      createdAt: new Date().toISOString(), expiresAt: command.deadline };
    let input = await deps.store.getTaskInput(`remote-input:${command.id}`);
    if (input) {
      const accepted = input.payload.remoteDevice as RemoteDispatchCommand | undefined;
      if (accepted?.payloadHash !== command.payloadHash || accepted.deviceId !== command.deviceId)
        throw new Error("remote_command_identity_changed");
    } else {
      if (!["follow_up", "steer", "start"].includes(command.action)) throw new Error("remote_action_unavailable");
      let sessionId = command.localSessionId!;
      if (command.action === "start") {
        if (!deps.resolveStarter || !deps.createReserved) throw new Error("remote_start_unavailable");
        const source = await deps.resolveStarter(command);
        const session = await deps.createReserved({ ...remoteStarterPayload(source), title: command.payload.text?.slice(0, 120) ?? "Remote task" }, {
          sessionId: `remote-session-${createHash("sha256").update(command.id).digest("hex")}`,
          operationId: command.id, payloadHash: command.payloadHash,
          owner: DeviceLocalOwnerSchema.parse(source.metadata?.ponderLocalOwner), remoteStarterSourceSessionId: source.id,
        });
        sessionId = session.id;
      } else {
        const target = await deps.inspect(sessionId);
        if (!target.canSendFollowup || (command.action === "steer" && !target.canSteer)) throw new Error("remote_target_unavailable");
      }
      if (!command.payload.text?.trim()) throw new Error("remote_message_required");
      input = await deps.admit({ id: `remote-input:${command.id}`, sessionId, senderSessionId: null,
        senderKind: "user", kind: command.action === "steer" ? "steer" : "queued", body: command.payload.text,
        idempotencyKey: `remote:${command.id}`, expectedTurnId: command.expectedTurnId ?? null,
        replyTo: null, payload: { remoteDevice: command } });
    }
    receipt.localSessionId = input.sessionId; receipt.inputId = input.id;
    if (input.turnId) receipt.turnId = input.turnId;
    await deps.store.saveRemoteDeviceReceipt(command, receipt);
    return receipt;
  };
}
