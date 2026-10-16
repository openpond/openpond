import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { remoteDevicePermitMessage, type RemoteDispatchCommand, type RuntimeEvent } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { createSessionStore } from "../store/session-store.js";
import { remoteCommandTargetRevision } from "./command-target.js";
import { captureRemoteTaskCatalog } from "./catalog.js";
import { readRemoteHistory } from "./history.js";

// Publishing one selected coordinator must not publish other hidden sessions;
// disabling it must fence actual SQLite admission/history, not merely hide a row.
it("publishes only the selected owner-consented Ponder and fences access after disable/restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-ponder-"));
  let store = new SqliteStore(directory);
  const owner = {version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId: null, audience: "https://fixture.invalid"};
  const keys = generateKeyPairSync("ed25519");
  const authority = {deviceId: randomUUID(), owner, fence: 1, grantRevision: 1,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    publicKeys: [{keyId: "fixture", publicKey: keys.publicKey.export({type: "spki", format: "pem"}).toString()}]};
  try {
    await store.initializeRemoteDeviceStore();
    const sessions = createSessionStore({store, defaultSessionCwd: () => directory, appendRuntimeEvent: async () => {}});
    const coordinatorId = randomUUID();
    const ponder = await sessions.createSession({provider: "openai", systemKind: "openpond.ponder", hiddenFromDefaultSidebar: true,
      metadata: {localPonderCoordinatorId: coordinatorId}});
    const hidden = await sessions.createSession({provider: "openai", hiddenFromDefaultSidebar: true, metadata: {ponderLocalOwner: owner}});
    await store.saveLocalPonderState({id: coordinatorId, sessionId: ponder.id, location: "local", modelRef: null, revision: 1,
      remoteAccessEnabled: false, hostedSandboxesEnabled: false, hostedActivation: "inactive"});
    const publish = () => store.configureLocalPonderRemoteAccess({enabled: true, revision: 1, owner, assertCurrent() {}});
    const races = await Promise.allSettled([publish(), publish()]);
    expect(races.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(store.configureLocalPonderRemoteAccess({enabled: true, revision: 2,
      owner: {...owner, ownerUserId: "other"}, assertCurrent() {}})).rejects.toThrow("remote_ponder_owner_changed");
    const session = (await store.getSession(ponder.id))!;
    const target = {sessionId: ponder.id, provider: session.provider, title: session.title, managedSessionId: session.id,
      targetRevision: "fixture", latestTurnId: null, activeTurnId: null, paused: false, approvalBlocked: false,
      canSendFollowup: true, canSteer: true, unavailableReason: null, inbox: await store.taskInboxSnapshot(ponder.id)};
    const published = await captureRemoteTaskCatalog({owner, ponder: await store.localPonderState(), sessions: [session, hidden], inspect: async () => target});
    expect(published.map(task => task.id)).toEqual([ponder.id]);
    expect(published[0]?.ponderCoordinatorId).toBe(coordinatorId);
    await store.setRemoteDeviceAuthority(authority);
    const command = (): RemoteDispatchCommand => {
      const id = randomUUID();
      const unsigned = {id, idempotencyKey: id, action: "follow_up" as const, targetId: "remote-task", localSessionId: session.id,
        expectedRevision: remoteCommandTargetRevision(session, null, {paused: false, activeTurnId: null}), payload: {text: "A remote instruction"},
        deviceId: authority.deviceId, payloadHash: "a".repeat(64), scope: {installationId: owner.installationId,
          profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: null}, grantRevision: 1, fence: 1,
        deadline: new Date(Date.now() + 30000).toISOString(), actor: "remote-human" as const};
      const expiresAt = new Date(Date.now() + 15000).toISOString();
      return {...unsigned, permit: {keyId: "fixture", expiresAt,
        signature: sign(null, Buffer.from(remoteDevicePermitMessage(unsigned, expiresAt, "fixture")), keys.privateKey).toString("base64")}};
    };
    const admit = (value: RemoteDispatchCommand) => store.admitTaskInput({id: `remote-input:${value.id}`, sessionId: session.id,
      senderSessionId: null, senderKind: "user", kind: "queued", body: value.payload.text!, payload: {remoteDevice: value},
      idempotencyKey: `remote:${value.id}`, expectedTurnId: null, replyTo: null});
    await admit(command());
    await store.configureLocalPonderRemoteAccess({enabled: false, revision: 2, owner, assertCurrent() {}});
    await expect(admit(command())).rejects.toThrow("remote_ponder_access_off");
    await expect(readRemoteHistory({store, owner, ponder: await store.localPonderState(), taskId: session.id, cursor: null})).rejects.toThrow("remote_ponder_access_off");
    await store.close(); store = new SqliteStore(directory);
    expect((await store.localPonderState())?.remoteAccessEnabled).toBe(false);
    expect((await store.getSession(session.id))?.metadata?.ponderLocalOwner).toEqual(owner);
    expect(await store.taskInputsForSession(session.id, {afterSequence: 0, limit: 10})).toHaveLength(1);
  } finally { await store.close(); await rm(directory, {recursive: true, force: true}); }
});

// A coordination body split by the byte budget must resume at the next fragment,
// not retransmit its prefix or lose body bytes across history pages.
it("retains coordination bodies exactly across persisted history page boundaries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-peer-history-"));
  const store = new SqliteStore(directory);
  const owner = {version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId: null, audience: "https://fixture.invalid"};
  try {
    const sessions = createSessionStore({store, defaultSessionCwd: () => directory, appendRuntimeEvent: async () => {}, captureUserOwner: async () => owner});
    const session = await sessions.createUserSession({provider: "openpond"});
    const body = "x".repeat(32000);
    for (let index = 0; index < 8; index++) {
      const timestamp = new Date().toISOString();
      const input = {id: `peer-${index}`, sequence: index, sessionId: session.id, senderSessionId: "worker",
        senderKind: "task", kind: "result", body, payload: {}, idempotencyKey: `peer-${index}`,
        replyTo: null, expectedTurnId: null, turnId: null, requestIds: [], state: "resolved", revision: 1,
        createdAt: timestamp, updatedAt: timestamp, error: null};
      await store.appendRuntimeEvent({id: randomUUID(), sessionId: session.id, name: "task.input", source: "server", status: "completed",
        timestamp, data: {input, delivery: {direction: "received", peer: {sessionId: "worker", title: "worker".repeat(100), provider: "codex"}}}} as RuntimeEvent);
    }
    const fragments = new Map<string, string>();
    let cursor: string | null = null;
    let pages = 0;
    let partial = false;
    do {
      const page = await readRemoteHistory({store, owner, taskId: session.id, cursor});
      for (const item of page.items) {
        if (item.coordinationInputId) fragments.set(item.coordinationInputId, (fragments.get(item.coordinationInputId) ?? "") + item.text);
      }
      cursor = page.nextCursor;
      if (cursor) partial ||= JSON.parse(Buffer.from(cursor, "base64url").toString()).fragment > 0;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(partial).toBe(true);
    expect(fragments.size).toBe(8);
    for (const text of fragments.values()) expect(text).toBe(body);
  } finally {await store.close(); await rm(directory, {recursive: true, force: true});}
});
