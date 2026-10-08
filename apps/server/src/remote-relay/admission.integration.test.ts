import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { remoteDevicePermitMessage, type RemoteDispatchCommand } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { createSessionStore } from "../store/session-store.js";
import { localSessionOwnershipRevision } from "./session-ownership.js";
import { createRemoteCommandExecutor } from "./executor.js";

// Losing the cloud acknowledgement cannot duplicate input after restart, while
// changed owners, forged permits and revoked authority cannot admit new input.
it("fences remote authority at canonical SQLite admission and recovers the original input after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-admission-"));
  let store = new SqliteStore(directory);
  const owner = { version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId: "team", audience: "https://fixture.invalid" };
  const keys = generateKeyPairSync("ed25519");
  const authority = { deviceId: randomUUID(), owner, fence: 1, grantRevision: 1,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    publicKeys: [{ keyId: "fixture", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  try {
    await store.initializeRemoteDeviceStore();
    const sessions = createSessionStore({ store, defaultSessionCwd: () => directory, appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); }, captureUserOwner: async () => owner });
    const session = await sessions.createUserSession({ provider: "codex", title: "Owned task", cwd: directory });
    await store.setRemoteDeviceAuthority(authority);
    const command = (id = randomUUID()): RemoteDispatchCommand => {
      const unsigned = { id, idempotencyKey: id, action: "follow_up" as const, targetId: "cloud-task", localSessionId: session.id,
        expectedRevision: Number.parseInt(localSessionOwnershipRevision(session, null).slice(0, 13), 16),
        payload: { text: "Continue the original task" }, deviceId: authority.deviceId, payloadHash: "a".repeat(64),
        scope: { installationId: owner.installationId, profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: owner.teamId },
        grantRevision: 1, fence: 1, deadline: new Date(Date.now() + 30000).toISOString(), actor: "remote-human" as const };
      const expiresAt = new Date(Date.now() + 15000).toISOString();
      return { ...unsigned, permit: { keyId: "fixture", expiresAt,
        signature: sign(null, Buffer.from(remoteDevicePermitMessage(unsigned, expiresAt, "fixture")), keys.privateKey).toString("base64") } };
    };
    const admit = (value: RemoteDispatchCommand) => store.admitTaskInput({ id: `remote-input:${value.id}`, sessionId: session.id,
      senderSessionId: null, senderKind: "user", kind: "queued", body: value.payload.text!, payload: { remoteDevice: value },
      idempotencyKey: `remote:${value.id}`, expectedTurnId: null, replyTo: null });
    const original = command();
    const input = await admit(original);
    await expect(admit({ ...command(), permit: { ...original.permit, signature: "forged" } })).rejects.toThrow("remote_permit_invalid");
    await store.setRemoteDeviceAuthority(null);
    await expect(admit(command())).rejects.toThrow("remote_authority_unavailable");
    await store.close(); store = new SqliteStore(directory); await store.initializeRemoteDeviceStore();
    const execute = createRemoteCommandExecutor({ store, inspect: async () => { throw new Error("Recovery must not perform mutable readiness checks"); },
      admit: async () => { throw new Error("Recovery must not repeat admission"); }, interrupt: async () => null });
    const receipt = await execute(original);
    expect(receipt.inputId).toBe(input.id);
    expect((await store.taskInputsForSession(session.id, { afterSequence: 0, limit: 10 })).length).toBe(1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
