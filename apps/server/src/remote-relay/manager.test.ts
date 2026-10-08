import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { SqliteStore } from "../store/store.js";
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
  server.on("connection", connection => connection.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "hello") {
      const parsed = z.object({ protocolVersion: z.literal(1), epoch: z.string().optional(), fence: z.number().int().positive().optional(),
        type: z.literal("hello"), payload: z.object({ ticket: z.literal("ticket") }) }).safeParse(frame);
      helloValid = parsed.success;
      if (!parsed.success) { connection.close(1008, "invalid_frame"); return; }
      connection.send(JSON.stringify({ protocolVersion: 1, type: "hello", payload: { deviceId, epoch: "epoch", fence: 1,
        grantRevision: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }));
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
    } }), inspect: async () => { throw new Error("No tasks"); }, execute: async () => { throw new Error("No commands"); },
    outputs: async () => [], readOutput: async () => { throw new Error("No artifacts"); }, listen: () => () => {}, warn: () => {} });
  try {
    await manager.start();
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("connected");
    await expect.poll(() => catalogSeen, { timeout: 3000 }).toBe(true);
    expect(helloValid).toBe(true);
    await manager.setEnabled(false);
    expect(disableTarget).toBe(deviceId);
    expect(manager.status().state).toBe("off");
  } finally {
    await manager.close(); for (const connection of server.clients) connection.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close(); await rm(directory, { recursive: true, force: true });
  }
});
