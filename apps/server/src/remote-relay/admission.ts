import { createPublicKey, verify } from "node:crypto";
import { remoteDeviceCanonicalContent, remoteDevicePermitMessage, type RemoteDispatchCommand, type RemoteDeviceServicePublicKey, type Session } from "@openpond/contracts";
import type { OpenPondSqliteConnection } from "../store/sqlite/sqlite-driver.js";
import { DeviceLocalOwnerSchema, deviceOwnsLocalSession } from "./local-scope.js";
import { readRemoteCommandTargetState, remoteCommandTargetRevision } from "./command-target.js";
import { remoteStarterRevision } from "./starters.js";
import { readLocalSessionReservation } from "../store/local-session-reservation.js";

export type RemoteLocalAuthority = { deviceId: string; owner: import("./local-scope.js").DeviceLocalOwner;
  fence: number; grantRevision: number; leaseExpiresAt: string; publicKeys: RemoteDeviceServicePublicKey[] };
export const REMOTE_LOCAL_SCHEMA = `CREATE TABLE IF NOT EXISTS remote_device_authority (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS remote_device_receipts (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, command TEXT NOT NULL, receipt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS remote_device_approval_claims (approval_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS remote_device_cancellations (id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,device_id TEXT NOT NULL);`;

/** Run inside canonical admission's BEGIN IMMEDIATE: logout and admission linearize here. */
export function assertRemoteAdmission(db: OpenPondSqliteConnection, command: RemoteDispatchCommand, session: Session) {
  if (command.payload.resume === true && command.action !== "follow_up") throw new Error("remote_resume_action_invalid");
  const cancelled = db.get<{ payload_hash: string }>("SELECT payload_hash FROM remote_device_cancellations WHERE id=?", [command.id]);
  if (cancelled) throw new Error(cancelled.payload_hash === command.payloadHash ? "remote_command_cancelled" : "remote_command_identity_changed");
  const row = db.get<{ payload: string }>("SELECT payload FROM remote_device_authority WHERE id=1");
  if (!row) throw new Error("remote_authority_unavailable");
  const authority = JSON.parse(row.payload) as RemoteLocalAuthority;
  const now = Date.now();
  if (command.actor !== "remote-human" || authority.deviceId !== command.deviceId || authority.fence !== command.fence
    || authority.grantRevision !== command.grantRevision || !(Date.parse(authority.leaseExpiresAt) > now)
    || !(Date.parse(command.deadline) > now) || !(Date.parse(command.permit.expiresAt) > now))
    throw new Error("remote_authority_expired_or_changed");
  const owner = DeviceLocalOwnerSchema.parse(authority.owner);
  if (remoteDeviceCanonicalContent(command.scope) !== remoteDeviceCanonicalContent({ installationId: owner.installationId,
    profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: owner.teamId }) || !deviceOwnsLocalSession(session, owner))
    throw new Error("remote_task_not_owned");
  const key = authority.publicKeys.find(key => key.keyId === command.permit.keyId);
  const { permit, ...unsigned } = command;
  if (!key || !verify(null, Buffer.from(remoteDevicePermitMessage(unsigned, permit.expiresAt, permit.keyId)),
    createPublicKey(key.publicKey), Buffer.from(permit.signature, "base64"))) throw new Error("remote_permit_invalid");
  if (command.action === "start") {
    const sourceId = session.metadata?.remoteStarterSourceSessionId;
    const sourceRow = typeof sourceId === "string" ? db.get<{ payload: string }>("SELECT payload FROM sessions WHERE id=?", [sourceId]) : null;
    const source = sourceRow ? JSON.parse(sourceRow.payload) as Session : null;
    const reservation = readLocalSessionReservation(session);
    if (!source || !deviceOwnsLocalSession(source, owner) || source.archived || source.status === "closed"
      || command.payload.projectId !== source.localProjectId || command.payload.starterRevision !== remoteStarterRevision(source)
      || command.expectedRevision !== remoteStarterRevision(source) || reservation?.operationId !== command.id
      || reservation.payloadHash !== command.payloadHash) throw new Error("remote_starter_changed");
    return;
  }
  const latest = db.get<{ id: string }>("SELECT id FROM turns WHERE session_id=? ORDER BY sort_index DESC LIMIT 1", [session.id]);
  const revision = remoteCommandTargetRevision(session, latest?.id ?? null, readRemoteCommandTargetState(db, session.id));
  if (command.localSessionId !== session.id || revision !== command.expectedRevision) throw new Error("remote_target_changed");
}
