import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import type { RuntimeEvent } from "@openpond/contracts";
import { WebSocketServer } from "ws";
import { SqliteStore } from "../store/store.js";
import { createSessionStore } from "../store/session-store.js";
import { loadDeviceInstallation } from "./installation.js";
import { createRemoteRelayManager } from "./manager.js";

// A broker rejects null pre-authentication epoch/fence fields. The desktop must
// finish its first authenticated hello and publish a catalog over the real socket.
it("authenticates its initial socket before publishing leased frames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-manager-"));
  const store = new SqliteStore(directory);
  const installation = await loadDeviceInstallation(directory);
  const deviceId = randomUUID();
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test socket");
  let catalogSeen = false;
  let helloValid = false;
  let disableTarget: unknown;
  let snapshotSeen = false;
  let rejectionError: unknown;
  let listener = (_event: RuntimeEvent) => {};
  const received: any[] = [];
  server.on("connection", connection => connection.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    received.push(frame);
    if (frame.type === "hello") {
      const parsed = z.object({ protocolVersion: z.literal(1), epoch: z.string().optional(), fence: z.number().int().positive().optional(),
        type: z.literal("hello"), payload: z.object({ ticket: z.literal("ticket") }) }).safeParse(frame);
      helloValid = parsed.success;
      if (!parsed.success) { connection.close(1008, "invalid_frame"); return; }
      connection.send(JSON.stringify({ protocolVersion: 1, type: "hello", payload: { deviceId, epoch: "epoch", fence: 1,
        grantRevision: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }));
    } else if (frame.type === "receipt") {
      rejectionError = frame.payload.error;
    } else if (frame.type === "snapshot") {
      snapshotSeen = frame.requestId === "read-request" && Array.isArray(frame.payload.items);
    } else if (frame.type === "catalog") {
      catalogSeen = frame.epoch === "epoch" && frame.fence === 1 && frame.payload.complete === true;
    }
  }));
  const owner = { version: 1 as const, installationId: installation.installationId, profileId: "profile", ownerUserId: "owner", teamId: "team", audience: "https://fixture.invalid" };
  const manager = createRemoteRelayManager({ storeDir: directory, installation, store,
    current: async () => ({ owner, credentialKey: "credential", request: async ({ path: route, body }) => {
      if (route.endsWith("enroll")) return { device: { id: deviceId, revision: 1 } };
      if (route.endsWith("service-keys")) return { keys: [{ keyId: "fixture", publicKey: installation.publicKey }] };
      if (route.endsWith("connection-tickets")) return { ticket: "ticket", connectUrl: `ws://127.0.0.1:${address.port}` };
      if (route.endsWith("device-management")) { disableTarget = (body as { payload: { targetDeviceId?: string } }).payload.targetDeviceId; return { device: { id: deviceId, revision: 2 } }; }
      throw new Error("Unexpected device request");
    } }), inspect: async id => {
      const session = (await store.getSession(id))!;
      const turn = await store.latestTurnForSession(id); const activeTurnId = turn?.status === "in_progress" ? turn.id : null;
      return { sessionId: id, provider: session.provider, title: session.title, targetRevision: "fixture",
        managedSessionId: "original-thread", latestTurnId: turn?.id ?? null, activeTurnId, paused: false,
        approvalBlocked: false, canSendFollowup: true, canSteer: !!activeTurnId, unavailableReason: null,
        inbox: { sessionId: id, activeTurnId, acceptingInput: !!activeTurnId, paused: false, inputs: [], waits: [] } };
    }, execute: async () => { z.object({ modelRef: z.object({ id: z.string() }) }).parse({ modelRef: null }); throw new Error("No commands"); },
    outputs: async () => [], readOutput: async () => { throw new Error("No artifacts"); }, listen: fn => { listener = fn; return () => {}; }, warn: () => {} });
  try {
    await manager.start();
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("connected");
    await expect.poll(() => catalogSeen, { timeout: 3000 }).toBe(true);
    expect(helloValid).toBe(true);
    const sessions = createSessionStore({ store, defaultSessionCwd: () => directory,
      appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); }, captureUserOwner: async () => owner });
    const session = await sessions.createUserSession({ provider: "codex", title: "Owned history", cwd: directory });
    const connection = [...server.clients][0]!;
    connection.send(JSON.stringify({ protocolVersion: 1, type: "subscribe", payload: { taskId: session.id, viewerId: "viewer" } }));
    connection.send(JSON.stringify({ protocolVersion: 1, type: "subscribe", requestId: "read-request", payload: { taskId: session.id, viewerId: "viewer" } }));
    await expect.poll(() => snapshotSeen, { timeout: 3000 }).toBe(true);
    const turnId = randomUUID();
    await store.insertTurn({ id: turnId, sessionId: session.id, providerTurnId: "provider-turn", prompt: "Controlled activation",
      startedAt: new Date().toISOString(), completedAt: null, status: "in_progress", error: null, metadata: {}, createImproveRun: null });
    const activation: RuntimeEvent = { id: randomUUID(), timestamp: new Date().toISOString(), sessionId: session.id,
      turnId, name: "turn.started", source: "server", status: "started", args: { prompt: "Controlled activation" } };
    await store.appendRuntimeEvent(activation); listener(activation);
    // Short turns must publish the exact control revision before their live state.
    await expect.poll(() => received.some(frame => frame.type === "events" && frame.payload.items.some((item: any) => item.turnId === turnId)), { timeout: 3000 }).toBe(true);
    const catalogIndex = received.findIndex(frame => frame.type === "catalog" && frame.payload.tasks.some((task: any) => task.activeTurnId === turnId && task.capabilities.steer && task.capabilities.stop));
    const eventIndex = received.findIndex(frame => frame.type === "events" && frame.payload.items.some((item: any) => item.turnId === turnId));
    expect(catalogIndex).toBeGreaterThanOrEqual(0); expect(catalogIndex).toBeLessThan(eventIndex);
    const catalogsBeforeTokens = received.filter(frame => frame.type === "catalog").length;
    const token: RuntimeEvent = { id: randomUUID(), timestamp: new Date().toISOString(), sessionId: session.id,
      turnId, name: "assistant.delta", source: "provider", output: "Bounded streaming text" };
    await store.appendRuntimeEvent(token); listener(token);
    await expect.poll(() => received.some(frame => frame.type === "events" && frame.payload.items.some((item: any) => item.text === token.output)), { timeout: 3000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(received.filter(frame => frame.type === "catalog")).toHaveLength(catalogsBeforeTokens);
    connection.send(JSON.stringify({ protocolVersion: 1, type: "command", payload: { id: randomUUID(), deviceId,
      payloadHash: "a".repeat(64), action: "start", targetId: "starter", deadline: new Date(Date.now() + 60_000).toISOString() } }));
    await expect.poll(() => rejectionError, { timeout: 3000 }).toBe("remote_command_configuration_invalid");
    await manager.setEnabled(false);
    expect(disableTarget).toBe(deviceId);
    expect(manager.status().state).toBe("off");
  } finally {
    await manager.close(); for (const connection of server.clients) connection.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close(); await rm(directory, { recursive: true, force: true });
  }
});
