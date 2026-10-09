import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { remoteDevicePermitMessage, type RemoteDispatchCommand } from "@openpond/contracts";
import { SqliteStore } from "../store/store.js";
import { createSessionStore } from "../store/session-store.js";
import { remoteCommandTargetRevision } from "./command-target.js";
import { normalizeRemoteEventTurn, projectRemoteEvent } from "./history.js";
import { createRemoteCommandExecutor } from "./executor.js";
import { captureRemoteTaskCatalog } from "./catalog.js";
import { createLocalManagedMessaging } from "../runtime/task-inbox/local-managed-messaging.js";

// Losing the cloud acknowledgement cannot duplicate input after restart, while
// changed owners, forged permits and revoked authority cannot admit new input.
it.each([null, "team"])("fences %s scope at canonical SQLite admission and recovers the original input after restart", async teamId => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-admission-"));
  let store = new SqliteStore(directory);
  const owner = { version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId, audience: "https://fixture.invalid" };
  const keys = generateKeyPairSync("ed25519");
  const authority = { deviceId: randomUUID(), owner, fence: 1, grantRevision: 1,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    publicKeys: [{ keyId: "fixture", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  try {
    await store.initializeRemoteDeviceStore();
    const sessions = createSessionStore({ store, defaultSessionCwd: () => directory, appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); }, captureUserOwner: async () => owner });
    const session = await sessions.createUserSession({ provider: "codex", title: "Owned task", cwd: directory });
    await store.setRemoteDeviceAuthority(authority);
    const command = (id = randomUUID(), scopeTeamId: string | null = teamId): RemoteDispatchCommand => {
      const unsigned = { id, idempotencyKey: id, action: "follow_up" as const, targetId: "cloud-task", localSessionId: session.id,
        expectedRevision: remoteCommandTargetRevision(session, null, { paused: false, activeTurnId: null }),
        payload: { text: "Continue the original task" }, deviceId: authority.deviceId, payloadHash: "a".repeat(64),
        scope: { installationId: owner.installationId, profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: scopeTeamId },
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
    // A valid service signature cannot widen personal ownership to a workspace,
    // or make a workspace command act on the account's personal tasks.
    await expect(admit(command(randomUUID(), teamId === null ? "team" : null))).rejects.toThrow("remote_task_not_owned");
    await store.setRemoteDeviceAuthority({ ...authority, owner: { ...owner, teamId: teamId === null ? "team" : null } });
    await expect(admit(command())).rejects.toThrow("remote_task_not_owned");
    await store.setRemoteDeviceAuthority(authority);
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

// Providers identify approvals by their own turn ID. Remote controls use the
// canonical local turn; the mapping must retain that exact turn and one claim.
it("maps provider approval identity to the active local turn and fences competing controls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-approval-"));
  const store = new SqliteStore(directory);
  const owner = { version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId: "team", audience: "https://fixture.invalid" };
  const keys = generateKeyPairSync("ed25519");
  const authority = { deviceId: randomUUID(), owner, fence: 1, grantRevision: 1, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    publicKeys: [{ keyId: "fixture", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  try {
    await store.initializeRemoteDeviceStore();
    const sessions = createSessionStore({ store, defaultSessionCwd: () => directory, appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); }, captureUserOwner: async () => owner });
    const session = await sessions.createUserSession({ provider: "codex", title: "Approval identity", cwd: directory });
    const turn = { id: randomUUID(), sessionId: session.id, providerTurnId: randomUUID(), prompt: "Controlled approval", startedAt: new Date().toISOString(), completedAt: null,
      status: "in_progress" as const, error: null, metadata: {}, createImproveRun: null };
    await store.insertTurn(turn);
    const approval = { id: randomUUID(), sessionId: session.id, turnId: turn.providerTurnId, providerRequestId: "request", kind: "command" as const,
      title: "Controlled command", detail: "sleep 45; printf DONE", status: "pending" as const, createdAt: new Date().toISOString() };
    await store.upsertApproval(approval); await store.setRemoteDeviceAuthority(authority);
    const projected = projectRemoteEvent(await normalizeRemoteEventTurn(store, {
      id: "approval-event", timestamp: new Date().toISOString(), sessionId: session.id, turnId: turn.providerTurnId,
      name: "approval.requested", source: "provider", status: "pending", data: approval,
    }), 1);
    expect(projected?.turnId).toBe(turn.id); expect(projected?.approvalId).toBe(approval.id);
    expect(projectRemoteEvent({ id: "resolved", timestamp: new Date().toISOString(), name: "approval.resolved",
      source: "server", status: "completed", data: { decision: "accept", approvalId: approval.id } }, 2)?.status).toBe("accepted");
    const command = (expectedTurnId: string = turn.id, expectedApprovalId: string = approval.id): RemoteDispatchCommand => {
      const id = randomUUID(); const unsigned = { id, idempotencyKey: id, action: "approval" as const, targetId: "cloud-task", localSessionId: session.id,
        expectedRevision: remoteCommandTargetRevision(session, turn.id, { paused: false, activeTurnId: null }), expectedTurnId, expectedApprovalId,
        payload: { response: "approve" as const }, deviceId: authority.deviceId, payloadHash: "a".repeat(64),
        scope: { installationId: owner.installationId, profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: owner.teamId },
        grantRevision: 1, fence: 1, deadline: new Date(Date.now() + 30000).toISOString(), actor: "remote-human" as const };
      const expiresAt = new Date(Date.now() + 15000).toISOString();
      return { ...unsigned, permit: { keyId: "fixture", expiresAt,
        signature: sign(null, Buffer.from(remoteDevicePermitMessage(unsigned, expiresAt, "fixture")), keys.privateKey).toString("base64") } };
    };
    await expect(store.admitRemoteDeviceApproval(command("old-local-turn"))).rejects.toThrow("remote_turn_changed");
    await expect(store.admitRemoteDeviceApproval(command(turn.id, "old-approval"))).rejects.toThrow("remote_approval_changed_or_unsupported");
    await store.upsertApproval({ ...approval, turnId: null });
    await expect(store.admitRemoteDeviceApproval(command())).rejects.toThrow("remote_approval_changed_or_unsupported");
    await store.upsertApproval(approval);
    const admitted = await store.admitRemoteDeviceApproval(command());
    expect(admitted.turnId).toBe(turn.id); expect(admitted.approvalId).toBe(approval.id);
    await expect(store.admitRemoteDeviceApproval(command())).rejects.toThrow("remote_approval_already_claimed");
    expect((await store.getApproval(approval.id))?.status).toBe("pending");
    await store.updateTurn(turn.id, current => ({ ...current, status: "interrupted", completedAt: new Date().toISOString() }));
    expect((await store.getApproval(approval.id))?.status).toBe("cancelled");
    expect(await store.pendingApprovals()).toHaveLength(0);
    await store.upsertApproval(approval);
    expect((await store.getApproval(approval.id))?.status).toBe("cancelled");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

// Failure story: an advertised default-model starter rejects canonical creation,
// duplicates the new task on retry, or loses its captured owner/configuration.
it.each(["codex", "openpond"] as const)("starts one owned %s task from a canonical default-model starter", async provider => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-start-"));
  let store = new SqliteStore(directory);
  const owner = { version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId: "team", audience: "https://fixture.invalid" };
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  try {
    await store.initializeRemoteDeviceStore();
    const sessions = createSessionStore({ store, defaultSessionCwd: () => directory, appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); }, captureUserOwner: async () => owner });
    const created = await sessions.createUserSession({ provider, experience: "work", localProjectId: "private-project", workspaceKind: "local_project", cwd: directory });
    const source = (await store.updateSession(created.id, session => ({ ...session, modelRef: null })))!;
    const { remoteStarterRevision, captureRemoteStarters } = await import("./starters.js");
    const starter = captureRemoteStarters([source], owner).get(`starter:${source.id}`)!.target;
    const id = randomUUID(); const unsigned = { id, idempotencyKey: id, action: "start" as const, targetId: starter.id,
      expectedRevision: remoteStarterRevision(source), expectedTurnId: null,
      payload: { text: "Controlled start", starterId: starter.id, starterRevision: starter.revision, projectId: starter.projectId },
      deviceId, payloadHash: "a".repeat(64), scope: { installationId: owner.installationId, profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: owner.teamId },
      grantRevision: 1, fence: 1, deadline: new Date(Date.now() + 30000).toISOString(), actor: "remote-human" as const };
    const expiresAt = new Date(Date.now() + 15000).toISOString();
    const command = { ...unsigned, permit: { keyId: "fixture", expiresAt,
      signature: sign(null, Buffer.from(remoteDevicePermitMessage(unsigned, expiresAt, "fixture")), keys.privateKey).toString("base64") } };
    await store.setRemoteDeviceAuthority({ deviceId, owner, fence: 1, grantRevision: 1, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      publicKeys: [{ keyId: "fixture", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] });
    const execute = createRemoteCommandExecutor({ store, resolveStarter: async () => source, createReserved: sessions.createReservedSession,
      inspect: async () => { throw new Error("Start must use the approved starter."); }, admit: input => store.admitTaskInput(input), interrupt: async () => null });
    const receipt = await execute(command);
    const target = (await store.getSession(receipt.localSessionId!))!;
    expect(target).toMatchObject({ provider, cwd: directory, localProjectId: source.localProjectId, metadata: { ponderLocalOwner: owner, remoteStarterSourceSessionId: source.id } });
    expect(await store.sessionCount()).toBe(2);
    await store.close(); store = new SqliteStore(directory); await store.initializeRemoteDeviceStore();
    const recover = createRemoteCommandExecutor({ store, inspect: async () => { throw new Error("Must recover original receipt."); },
      admit: async () => { throw new Error("Must not readmit start."); }, interrupt: async () => null });
    expect((await recover(command)).localSessionId).toBe(target.id);
    expect(await store.taskInputsForSession(target.id)).toHaveLength(1);
    expect(await store.sessionCount()).toBe(2);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

// A fresh explicit resume must survive a lost acknowledgement without admitting
// twice or undoing a newer Stop; stale clicks and ordinary sends keep work paused.
it("atomically resumes qualified paused work and never lets replay undo a later Stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-resume-"));
  let store = new SqliteStore(directory);
  const owner = { version: 1 as const, installationId: randomUUID(), profileId: "profile", ownerUserId: "owner", teamId: "team", audience: "https://fixture.invalid" };
  const keys = generateKeyPairSync("ed25519");
  const authority = { deviceId: randomUUID(), owner, fence: 1, grantRevision: 1,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    publicKeys: [{ keyId: "fixture", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] };
  try {
    await store.initializeRemoteDeviceStore();
    const sessions = createSessionStore({ store, defaultSessionCwd: () => directory,
      appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); }, captureUserOwner: async () => owner });
    const session = await sessions.createUserSession({ provider: "openpond", experience: "work", title: "Paused owned task", cwd: directory });
    const inspect = (id: string) => createLocalManagedMessaging({ store, getSession: id => store.getSession(id),
      latestTurn: id => store.latestTurnForSession(id), readiness: async () => ({ available: true, reason: null, canSteer: true }),
      approvalBlocked: async () => false, admit: input => store.admitTaskInput(input) }).inspect(id);
    const catalog = async () => (await captureRemoteTaskCatalog({ owner, sessions: [(await store.getSession(session.id))!], inspect,
      latestTurn: id => store.latestTurnForSession(id) }))[0]!;
    const command = (revision: number, expectedTurnId: string | null, resume = false, id = randomUUID()): RemoteDispatchCommand => {
      const unsigned = { id, idempotencyKey: id, action: "follow_up" as const, targetId: "cloud-task", localSessionId: session.id,
        expectedRevision: revision, expectedTurnId, payload: { text: "Continue the owned task", ...(resume ? { resume: true } : {}) },
        deviceId: authority.deviceId, payloadHash: id.replaceAll("-", "").padEnd(64, "0"),
        scope: { installationId: owner.installationId, profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: owner.teamId },
        grantRevision: 1, fence: 1, deadline: new Date(Date.now() + 30000).toISOString(), actor: "remote-human" as const };
      const expiresAt = new Date(Date.now() + 15000).toISOString();
      return { ...unsigned, permit: { keyId: "fixture", expiresAt,
        signature: sign(null, Buffer.from(remoteDevicePermitMessage(unsigned, expiresAt, "fixture")), keys.privateKey).toString("base64") } };
    };
    const admit = (value: RemoteDispatchCommand, id = `remote-input:${value.id}`) => store.admitTaskInput({ id, sessionId: session.id,
      senderSessionId: null, senderKind: "user", kind: "queued", body: value.payload.text!, payload: { remoteDevice: value },
      idempotencyKey: `remote:${value.id}`, expectedTurnId: value.expectedTurnId ?? null, replyTo: null });
    const turn = (id = randomUUID()) => ({ id, sessionId: session.id, providerTurnId: null, prompt: "Controlled work",
      startedAt: new Date().toISOString(), completedAt: null, status: "in_progress" as const, error: null, metadata: {}, createImproveRun: null });
    const first = turn();
    await store.insertTurn(first); await store.openTaskInboxTurn(session.id, first.id, "fixture-owner");
    await store.setRemoteDeviceAuthority(authority);
    const running = await catalog();
    await store.updateTurn(first.id, current => ({ ...current, status: "interrupted", completedAt: new Date().toISOString() }));
    await store.closeTaskInboxTurn(session.id, first.id, "fixture-owner", "interrupted");
    const paused = await catalog();
    expect(paused).toMatchObject({ paused: true, latestTurnId: first.id, activeTurnId: null, capabilities: { resume: true } });
    expect(paused.revision).not.toBe(running.revision);
    const ordinary = await admit(command(paused.revision, null));
    expect(await store.taskInboxPaused(session.id)).toBe(true);
    expect(await store.reserveTaskFollowup(session.id, randomUUID(), "fixture-owner")).toBeNull();
    await expect(admit(command(running.revision, first.id, true))).rejects.toThrow("remote_target_changed");
    await expect(admit(command(paused.revision, "older-turn", true))).rejects.toThrow("remote_resume_target_changed");
    // An INSERT failure after the clear must roll back both changes.
    await expect(admit(command(paused.revision, first.id, true), ordinary.id)).rejects.toThrow();
    expect(await store.taskInboxPaused(session.id)).toBe(true);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(1);
    const resume = command(paused.revision, first.id, true);
    const execute = createRemoteCommandExecutor({ store: { getTaskInput: id => store.getTaskInput(id),
      getRemoteDeviceReceipt: id => store.getRemoteDeviceReceipt(id), saveRemoteDeviceReceipt: async () => { throw new Error("lost acknowledgement"); },
      admitRemoteDeviceStop: value => store.admitRemoteDeviceStop(value), getTurn: id => store.getTurn(id),
      admitRemoteDeviceApproval: value => store.admitRemoteDeviceApproval(value), getApproval: id => store.getApproval(id) },
      inspect, admit: input => store.admitTaskInput(input), interrupt: async () => null });
    await expect(execute(resume)).rejects.toThrow("lost acknowledgement");
    expect(await store.taskInboxPaused(session.id)).toBe(false);
    const resumedInput = (await store.getTaskInput(`remote-input:${resume.id}`))!;
    expect(await store.taskInputsForSession(session.id)).toHaveLength(2);
    const afterResume = await catalog();
    expect(afterResume.revision).not.toBe(paused.revision);
    expect(afterResume.capabilities.resume).toBe(false);
    // Restart with no mutable inspection/admission allowed: input is recovery authority.
    await store.close(); store = new SqliteStore(directory); await store.initializeRemoteDeviceStore();
    const recover = createRemoteCommandExecutor({ store,
      inspect: async () => { throw new Error("Replay must not inspect mutable state"); },
      admit: async () => { throw new Error("Replay must not repeat admission"); }, interrupt: async () => null });
    const receipt = await recover(resume);
    expect(receipt.inputId).toBe(resumedInput.id);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(2);
    // Preserve canonical FIFO: explicit resume authorizes the existing queue too.
    const next = turn();
    expect((await store.reserveTaskFollowup(session.id, next.id, "fixture-owner"))?.id).toBe(ordinary.id);
    await store.insertTurn(next);
    await store.updateTurn(next.id, current => ({ ...current, status: "interrupted", completedAt: new Date().toISOString() }));
    await store.closeTaskInboxTurn(session.id, next.id, "fixture-owner", "interrupted");
    expect(await recover(resume)).toEqual(receipt);
    expect((await admit(resume)).id).toBe(resumedInput.id);
    expect(await store.taskInboxPaused(session.id)).toBe(true);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(2);
    await store.setRemoteDeviceAuthority(authority);
    await expect(admit(command(paused.revision, first.id, true))).rejects.toThrow("remote_target_changed");
    const latest = await catalog();
    await expect(admit(command(latest.revision, first.id, true))).rejects.toThrow("remote_resume_target_changed");
    expect(await store.taskInboxPaused(session.id)).toBe(true);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(2);
    await admit(command(latest.revision, next.id, true));
    expect(await store.taskInboxPaused(session.id)).toBe(false);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(3);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
