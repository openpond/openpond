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
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test socket");
  let catalogSeen = false;
  let helloValid = false;
  let disableTarget: unknown;
  let snapshotSeen = false;
  let rejectionError: unknown;
  let catalogRevision = 0;
  let rejectNextPatch = false;
  let signedIn = true;
  let slowCatalogAcknowledgements = false;
  let catalogPagesInFlight = 0;
  let maximumCatalogPagesInFlight = 0;
  let bulkBytes = 0;
  const enrolled = {
    id: deviceId,
    installationId: installation.installationId,
    profileId: "profile",
    name: "Fixture computer",
    platform: "linux",
    enabled: true,
    removed: false,
    revision: 1,
    status: "connected" as const,
    lastSeenAt: null,
    lastCatalogSyncAt: null,
    taskCount: 0,
  };
  let listener = (_event: RuntimeEvent) => {};
  const received: any[] = [];
  server.on("connection", (connection) =>
    connection.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      received.push(frame);
      if (frame.type === "hello") {
        const parsed = z
          .object({
            protocolVersion: z.literal(1),
            epoch: z.string().optional(),
            fence: z.number().int().positive().optional(),
            type: z.literal("hello"),
            payload: z.object({ ticket: z.literal("ticket") }),
          })
          .safeParse(frame);
        helloValid = parsed.success;
        if (!parsed.success) {
          connection.close(1008, "invalid_frame");
          return;
        }
        connection.send(
          JSON.stringify({
            protocolVersion: 1,
            type: "hello",
            payload: {
              deviceId,
              epoch: "epoch",
              fence: 1,
              grantRevision: 1,
              catalogRevision,
              minimumSupportedProtocolVersion: 1,
              supportedProtocolVersion: 1,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        );
      } else if (frame.type === "receipt") {
        rejectionError = frame.payload.error;
      } else if (frame.type === "snapshot") {
        snapshotSeen =
          frame.requestId === "read-request" &&
          Array.isArray(frame.payload.items);
      } else if (frame.type === "catalog") {
        if (rejectNextPatch && frame.payload.mode === "patch") {
          rejectNextPatch = false;
          catalogRevision += 10;
          connection.send(
            JSON.stringify({
              protocolVersion: 1,
              type: "error",
              deviceId,
              epoch: "epoch",
              fence: 1,
              payload: { error: "catalog_resync_required", catalogRevision },
            }),
          );
          return;
        }
        if (frame.payload.complete) catalogRevision = frame.payload.revision;
        const acknowledgeCatalogPage = () =>
          connection.send(
            JSON.stringify({
              protocolVersion: 1,
              type: "catalog_ack",
              deviceId,
              epoch: "epoch",
              fence: 1,
              payload: {
                mode: frame.payload.mode,
                pageIndex: frame.payload.pageIndex,
                snapshotId: frame.payload.snapshotId,
                revision: frame.payload.revision,
                committed: frame.payload.complete,
                catalogRevision,
              },
            }),
          );
        catalogPagesInFlight++;
        maximumCatalogPagesInFlight = Math.max(
          maximumCatalogPagesInFlight,
          catalogPagesInFlight,
        );
        if (slowCatalogAcknowledgements) {
          bulkBytes += Buffer.byteLength(JSON.stringify(frame.payload));
          setTimeout(() => {
            catalogPagesInFlight--;
            acknowledgeCatalogPage();
          }, 20);
        } else {
          catalogPagesInFlight--;
          acknowledgeCatalogPage();
        }
        catalogSeen =
          frame.epoch === "epoch" &&
          frame.fence === 1 &&
          frame.payload.complete === true;
      }
    }),
  );
  const owner = {
    version: 1 as const,
    installationId: installation.installationId,
    profileId: "profile",
    ownerUserId: "owner",
    teamId: "team",
    audience: "https://fixture.invalid",
  };
  const manager = createRemoteRelayManager({
    storeDir: directory,
    installation,
    store,
    accountStatus: async () => ({
      state: signedIn ? "ready" : "signed_out",
      account: signedIn ? { id: "owner", label: "Fixture owner" } : null,
      team: signedIn ? { id: "team" } : null,
      webBaseUrl: "https://staging.openpond.ai",
    }),
    current: async () =>
      signedIn
        ? {
            owner,
            credentialKey: "credential",
            request: async ({ path: route, body }) => {
              if (route.endsWith("enroll")) return { device: enrolled };
              if (route.endsWith("service-keys"))
                return {
                  keys: [
                    { keyId: "fixture", publicKey: installation.publicKey },
                  ],
                };
              if (route.endsWith("connection-tickets"))
                return {
                  ticket: "ticket",
                  connectUrl: `ws://127.0.0.1:${address.port}`,
                };
              if (route.endsWith("device-management")) {
                const payload = (
                  body as {
                    payload: { action: string; targetDeviceId?: string };
                  }
                ).payload;
                if (payload.action === "list") return { devices: [enrolled] };
                disableTarget = payload.targetDeviceId;
                if (payload.targetDeviceId === deviceId) {
                  enrolled.enabled = false;
                  enrolled.revision++;
                }
                return { device: enrolled };
              }
              throw new Error("Unexpected device request");
            },
          }
        : null,
    inspect: async (id) => {
      const session = (await store.getSession(id))!;
      const turn = await store.latestTurnForSession(id);
      const activeTurnId = turn?.status === "in_progress" ? turn.id : null;
      return {
        sessionId: id,
        provider: session.provider,
        title: session.title,
        targetRevision: "fixture",
        managedSessionId: "original-thread",
        latestTurnId: turn?.id ?? null,
        activeTurnId,
        paused: false,
        approvalBlocked: false,
        canSendFollowup: true,
        canSteer: !!activeTurnId,
        unavailableReason: null,
        inbox: {
          sessionId: id,
          activeTurnId,
          acceptingInput: !!activeTurnId,
          paused: false,
          inputs: [],
          waits: [],
        },
      };
    },
    execute: async () => {
      z.object({ modelRef: z.object({ id: z.string() }) }).parse({
        modelRef: null,
      });
      throw new Error("No commands");
    },
    outputs: async () => [],
    readOutput: async () => {
      throw new Error("No artifacts");
    },
    listen: (fn) => {
      listener = fn;
      return () => {};
    },
    warn: () => {},
  });
  try {
    await manager.start();
    await expect
      .poll(() => manager.status().state, { timeout: 3000 })
      .toBe("connected");
    await expect.poll(() => catalogSeen, { timeout: 3000 }).toBe(true);
    expect(helloValid).toBe(true);
    expect(
      received.find((frame) => frame.type === "catalog").payload.mode,
    ).toBe("snapshot");
    const sessions = createSessionStore({
      store,
      defaultSessionCwd: () => directory,
      appendRuntimeEvent: async (event) => {
        await store.appendRuntimeEvent(event);
      },
      captureUserOwner: async () => owner,
    });
    const session = await sessions.createUserSession({
      provider: "codex",
      title: "Owned history",
      cwd: directory,
    });
    const connection = [...server.clients][0]!;
    connection.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "subscribe",
        payload: { taskId: session.id, viewerId: "viewer" },
      }),
    );
    connection.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "subscribe",
        requestId: "read-request",
        payload: { taskId: session.id, viewerId: "viewer" },
      }),
    );
    await expect.poll(() => snapshotSeen, { timeout: 3000 }).toBe(true);
    const turnId = randomUUID();
    await store.insertTurn({
      id: turnId,
      sessionId: session.id,
      providerTurnId: "provider-turn",
      prompt: "Controlled activation",
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: "in_progress",
      error: null,
      metadata: {},
      createImproveRun: null,
    });
    const activation: RuntimeEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      turnId,
      name: "turn.started",
      source: "server",
      status: "started",
      args: { prompt: "Controlled activation" },
    };
    await store.appendRuntimeEvent(activation);
    listener(activation);
    // Short turns must publish the exact control revision before their live state.
    await expect
      .poll(
        () =>
          received.some(
            (frame) =>
              frame.type === "events" &&
              frame.payload.items.some((item: any) => item.turnId === turnId),
          ),
        { timeout: 3000 },
      )
      .toBe(true);
    const catalogIndex = received.findIndex(
      (frame) =>
        frame.type === "catalog" &&
        frame.payload.tasks.some(
          (task: any) =>
            task.activeTurnId === turnId &&
            task.capabilities.steer &&
            task.capabilities.stop,
        ),
    );
    const eventIndex = received.findIndex(
      (frame) =>
        frame.type === "events" &&
        frame.payload.items.some((item: any) => item.turnId === turnId),
    );
    expect(received[catalogIndex].payload.mode).toBe("patch");
    expect(received[catalogIndex].payload.baseRevision).toBeLessThan(
      received[catalogIndex].payload.revision,
    );
    expect(catalogIndex).toBeGreaterThanOrEqual(0);
    expect(catalogIndex).toBeLessThan(eventIndex);
    const catalogsBeforeTokens = received.filter(
      (frame) => frame.type === "catalog",
    ).length;
    const token: RuntimeEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      turnId,
      name: "assistant.delta",
      source: "provider",
      output: "Bounded streaming text",
    };
    await store.appendRuntimeEvent(token);
    listener(token);
    await expect
      .poll(
        () =>
          received.some(
            (frame) =>
              frame.type === "events" &&
              frame.payload.items.some(
                (item: any) => item.text === token.output,
              ),
          ),
        { timeout: 3000 },
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received.filter((frame) => frame.type === "catalog")).toHaveLength(
      catalogsBeforeTokens,
    );
    connection.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "command",
        payload: {
          id: randomUUID(),
          deviceId,
          payloadHash: "a".repeat(64),
          action: "start",
          targetId: "starter",
          deadline: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
    await expect
      .poll(() => rejectionError, { timeout: 3000 })
      .toBe("remote_command_configuration_invalid");
    // A stale hosted patch base must replace the directory without advancing
    // an unacknowledged base, and retirement must explicitly remove the source.
    rejectNextPatch = true;
    const updated = { ...session, title: "Changed owner-visible title" };
    await store.updateSession(session.id, () => updated);
    listener({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      name: "session.title.updated",
      source: "server",
    });
    await expect
      .poll(
        () =>
          received.some(
            (frame) =>
              frame.type === "catalog" &&
              frame.payload.mode === "snapshot" &&
              frame.payload.tasks.some(
                (task: any) => task.title === updated.title,
              ),
          ),
        { timeout: 3000 },
      )
      .toBe(true);
    await store.updateSession(session.id, () => ({
      ...updated,
      hiddenFromDefaultSidebar: true,
    }));
    listener({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      name: "session.updated",
      source: "server",
    });
    await expect
      .poll(
        () =>
          received.some(
            (frame) =>
              frame.type === "catalog" &&
              frame.payload.mode === "patch" &&
              frame.payload.removedIds.includes(session.id),
          ),
        { timeout: 3000 },
      )
      .toBe(true);
    // Upgrade explanations survive disconnect; only explicit owner retry can
    // clear the terminal state and establish another authenticated snapshot.
    [...server.clients][0]!.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "error",
        payload: {
          error: "protocol_unsupported",
          minimumSupportedProtocolVersion: 2,
        },
      }),
    );
    await expect
      .poll(() => manager.status().state, { timeout: 3000 })
      .toBe("update_required");
    expect(manager.status().minimumSupportedProtocolVersion).toBe(2);
    const helloCount = received.filter(
      (frame) => frame.type === "hello",
    ).length;
    await manager.settings("retry");
    await expect
      .poll(() => manager.status().state, { timeout: 3000 })
      .toBe("connected");
    expect(received.filter((frame) => frame.type === "hello").length).toBe(
      helloCount + 1,
    );
    const currentConnection = [...server.clients].find(
      (client) => client.readyState === 1,
    )!;
    currentConnection.close(1012, "worker_restart");
    await expect
      .poll(() => received.filter((frame) => frame.type === "hello").length, {
        timeout: 3000,
      })
      .toBe(helloCount + 2);
    await expect
      .poll(() => manager.status().state, { timeout: 3000 })
      .toBe("connected");
    await manager.settings("disable-device", {
      deviceId: randomUUID(),
      revision: 1,
    });
    expect(disableTarget).not.toBe(deviceId);
    // This snapshot exceeds the socket's one-MiB queue. Delay every page ACK
    // so a burst publisher fails while one-page pacing keeps the queue bounded.
    for (let index = 0; index < 650; index++) {
      await sessions.createUserSession({
        provider: "codex",
        title: `${index}:` + "x".repeat(990),
        cwd: directory,
        workspaceName: "w".repeat(990),
      });
    }
    slowCatalogAcknowledgements = true;
    maximumCatalogPagesInFlight = 0;
    bulkBytes = 0;
    await manager.settings("retry");
    await expect
      .poll(() => manager.status().state, { timeout: 10_000 })
      .toBe("connected");
    expect(bulkBytes).toBeGreaterThan(1_048_576);
    expect(maximumCatalogPagesInFlight).toBe(1);
    slowCatalogAcknowledgements = false;
    await manager.setEnabled(false);
    expect(disableTarget).toBe(deviceId);
    expect(manager.status().state).toBe("off");
    await expect(manager.settings("retry")).rejects.toThrow(
      "remote_access_off",
    );
    signedIn = false;
    expect(
      ((await manager.settings("status")) as { state: string }).state,
    ).toBe("signed_out");
  } finally {
    await manager.close();
    for (const connection of server.clients) connection.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
