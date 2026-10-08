import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderSettingsSchema, remoteDevicePermitMessage, type LocalManagedMessageTarget, type RemoteCommandReceipt, type RemoteDispatchCommand, type RuntimeEvent } from "@openpond/contracts";
import { WebSocketServer } from "ws";
import { SqliteStore } from "../store/store.js";
import { createSessionStore } from "../store/session-store.js";
import { loadDeviceInstallation } from "./installation.js";
import { createRemoteRelayManager } from "./manager.js";
import { deviceOwnerKey, loadRemoteAccessPreference } from "./preference.js";
import { createAccountAuthorityChange } from "../runtime/account-authority-change.js";
import { createLocalOwnerAttachmentInspection } from "../runtime/task-inbox/local-owner-attachment.js";
import { createRemoteCommandExecutor } from "./executor.js";
import { localSessionOwnershipRevision } from "./session-ownership.js";

// A broker rejects null pre-authentication epoch/fence fields. The desktop must
// finish its first authenticated hello and publish a catalog over the real socket.
it.each([null, "team"])("authenticates its %s socket before publishing leased frames", async teamId => {
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
  let openPondEnabled = true;
  let pauseAccountStatus: (() => Promise<void>) | null = null;
  let slowCatalogAcknowledgements = false;
  let catalogPagesInFlight = 0;
  let maximumCatalogPagesInFlight = 0;
  let bulkBytes = 0;
  let seedingBulkCatalog = false;
  const releaseCommands: Array<() => void> = [];
  const invalidCommand = async (_command: RemoteDispatchCommand) => {
    z.object({ modelRef: z.object({ id: z.string() }) }).parse({ modelRef: null });
    throw new Error("No commands");
  };
  let executeCommand: (command: RemoteDispatchCommand) => Promise<RemoteCommandReceipt> = invalidCommand;
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
  let owner = {
    version: 1 as const,
    installationId: installation.installationId,
    profileId: "profile",
    ownerUserId: "owner",
    teamId,
    audience: "https://fixture.invalid",
  };
  const inspect = async (id: string): Promise<LocalManagedMessageTarget> => {
    const session = (await store.getSession(id))!;
    const turn = await store.latestTurnForSession(id);
    const activeTurnId = turn?.status === "in_progress" ? turn.id : null;
    return { sessionId: id, provider: session.provider, title: session.title,
      targetRevision: "fixture", managedSessionId: "original-thread", latestTurnId: turn?.id ?? null,
      activeTurnId, paused: false, approvalBlocked: false, canSendFollowup: true,
      canSteer: !!activeTurnId, unavailableReason: null,
      inbox: { sessionId: id, activeTurnId, acceptingInput: !!activeTurnId,
        paused: false, inputs: [], waits: [] } };
  };
  const manager = createRemoteRelayManager({
    storeDir: directory,
    installation,
    store,
    accountStatus: async () => {
      const pause = pauseAccountStatus;
      pauseAccountStatus = null;
      await pause?.();
      return ({
      state: signedIn ? "ready" : "signed_out",
      account: signedIn ? { id: "owner", label: "Fixture owner" } : null,
      team: signedIn && owner.teamId ? { id: owner.teamId } : null,
      webBaseUrl: "https://staging.openpond.ai",
      });
    },
    current: async () =>
      signedIn
        ? {
            owner,
            credentialKey: "credential",
            request: async ({ path: route, body }) => {
              if (body) expect((body as { proof: { scope: { teamId: string | null } } }).proof.scope.teamId).toBe(owner.teamId);
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
    prepareOwnerAttachment: async capturedOwner => createLocalOwnerAttachmentInspection({
      owner: capturedOwner,
      providers: ProviderSettingsSchema.parse({ providers: {
        codex: { enabled: true }, openpond: { enabled: openPondEnabled },
      } }),
      codexStatus: async () => ({ available: true, binaryPath: null, version: null,
        authHealth: "signed_in", account: null, appServer: { status: "ready", lastError: null } }),
      loadProfile: async () => { throw new Error("This fixture has no Profile references"); },
      loadHarness: async () => { throw new Error("This fixture has no released workflow bindings"); },
    }),
    inspect,
    execute: command => executeCommand(command),
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
        if (event.name === "session.updated" && !seedingBulkCatalog) listener(event);
      },
      captureUserOwner: async () => owner,
    });
    const session = await sessions.createUserSession({
      provider: "codex",
      title: "Owned history",
      cwd: directory,
    });
    const unowned = await sessions.createSession({ provider: "codex", title: "Unresolved ownership", cwd: directory });
    await store.updateSession(unowned.id, value => ({ ...value, codexThreadId: "fixture-unowned-thread" }));
    // Older development tasks are ordinary local work. They become visible
    // only after an explicit, revision-fenced local ownership choice.
    const olderDevelopment = await sessions.createSession({ provider: "codex", experience: "development", title: "Older development task", cwd: directory });
    await store.updateSession(olderDevelopment.id, value => ({ ...value, codexThreadId: "fixture-development-thread" }));
    const settings = await manager.settings("status") as { unresolvedTasks: Array<{ id: string; revision: string }> };
    const unresolvedDevelopment = settings.unresolvedTasks.find(task => task.id === olderDevelopment.id)!;
    expect(unresolvedDevelopment).toBeDefined();
    expect((await store.getSession(olderDevelopment.id))?.metadata?.ponderLocalOwner).toBeUndefined();
    await manager.settings("attach", { sessionId: olderDevelopment.id, expectedRevision: unresolvedDevelopment.revision });
    expect((await store.getSession(olderDevelopment.id))?.metadata?.ponderLocalOwner).toEqual(owner);
    await expect.poll(() => received.filter(frame => frame.type === "catalog").some(frame => frame.payload.tasks.some((task: { id: string }) => task.id === olderDevelopment.id)), { timeout: 3000 }).toBe(true);
    const connection = [...server.clients][0]!;
    const command = async (sessionId: string): Promise<RemoteDispatchCommand> => {
      const target = (await store.getSession(sessionId))!;
      const latest = await store.latestTurnForSession(sessionId);
      const id = randomUUID();
      const unsigned = { id, idempotencyKey: id, action: "follow_up" as const, targetId: "fixture-task", localSessionId: sessionId,
        expectedRevision: Number.parseInt(localSessionOwnershipRevision(target, latest?.id ?? null).slice(0, 13), 16),
        expectedTurnId: null, payload: { text: `Original input ${id}` }, deviceId,
        payloadHash: createHash("sha256").update(id).digest("hex"),
        scope: { installationId: owner.installationId, profileId: owner.profileId, ownerUserId: owner.ownerUserId, teamId: owner.teamId },
        grantRevision: 1, fence: 1, deadline: new Date(Date.now() + 30_000).toISOString(), actor: "remote-human" as const };
      const expiresAt = new Date(Date.now() + 15_000).toISOString();
      return { ...unsigned, permit: { keyId: "fixture", expiresAt,
        signature: installation.sign(remoteDevicePermitMessage(unsigned, expiresAt, "fixture")) } };
    };
    const gate = () => {
      let entered = false;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      releaseCommands.push(release);
      return { get entered() { return entered; }, release,
        async wait() { entered = true; await held; } };
    };
    const sendFrame = (type: string, payload: unknown, requestId?: string) => connection.send(JSON.stringify({
      protocolVersion: 1, deviceId, epoch: "epoch", fence: 1, type, payload, ...(requestId ? { requestId } : {}),
    }));
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
    // Cancellation must reach the real SQLite arbiter while an earlier command
    // is awaiting admission. Commands themselves still enter that lane in order.
    const cancellationWinner = await command(session.id);
    const admissionWinner = await command(session.id);
    const beforeAdmission = gate();
    const afterAdmission = gate();
    const executionOrder: string[] = [];
    const admissionAttempts = new Map<string, number>();
    const execute = createRemoteCommandExecutor({ store, inspect, interrupt: async () => null,
      admit: async input => {
        const id = (input.payload.remoteDevice as RemoteDispatchCommand).id;
        admissionAttempts.set(id, (admissionAttempts.get(id) ?? 0) + 1);
        if (id === cancellationWinner.id) await beforeAdmission.wait();
        const admitted = await store.admitTaskInput(input);
        if (id === admissionWinner.id) await afterAdmission.wait();
        return admitted;
      } });
    executeCommand = async value => { executionOrder.push(value.id); return execute(value); };
    sendFrame("command", cancellationWinner);
    await expect.poll(() => beforeAdmission.entered, { timeout: 3000 }).toBe(true);
    sendFrame("command", admissionWinner);
    sendFrame("receipt_query", { commandId: cancellationWinner.id, payloadHash: cancellationWinner.payloadHash }, "held-before-sql");
    sendFrame("receipt_query", { commandId: admissionWinner.id, payloadHash: admissionWinner.payloadHash }, "queued-before-sql");
    for (const requestId of ["held-before-sql", "queued-before-sql"]) {
      await expect.poll(() => received.find(frame => frame.requestId === requestId), { timeout: 3000 })
        .toMatchObject({ type: "receipt_query_result", payload: { notAdmitted: false, receipt: null, cancelled: false } });
    }
    sendFrame("command_cancel", { commandId: cancellationWinner.id, payloadHash: cancellationWinner.payloadHash }, "cancel-before-sql");
    await expect.poll(() => received.find(frame => frame.requestId === "cancel-before-sql"), { timeout: 3000 })
      .toMatchObject({ type: "command_cancel_result", payload: { cancelled: true, receipt: null } });
    expect(await store.getRemoteDeviceCancellation(cancellationWinner.id)).toMatchObject({ payload_hash: cancellationWinner.payloadHash });
    expect(await store.getTaskInput(`remote-input:${cancellationWinner.id}`)).toBeNull();
    expect(await store.getTaskInput(`remote-input:${admissionWinner.id}`)).toBeNull();
    expect(executionOrder).toEqual([cancellationWinner.id]);
    beforeAdmission.release();
    await expect.poll(() => afterAdmission.entered, { timeout: 3000 }).toBe(true);
    expect(executionOrder).toEqual([cancellationWinner.id, admissionWinner.id]);
    await expect.poll(() => received.find(frame => frame.type === "receipt" && frame.payload.id === cancellationWinner.id), { timeout: 3000 })
      .toMatchObject({ payload: { state: "rejected", error: "remote_command_cancelled" } });
    sendFrame("receipt_query", { commandId: cancellationWinner.id, payloadHash: cancellationWinner.payloadHash }, "cancelled-after-sql-denial");
    await expect.poll(() => received.find(frame => frame.requestId === "cancelled-after-sql-denial"), { timeout: 3000 })
      .toMatchObject({ type: "receipt_query_result", payload: { cancelled: true, notAdmitted: true, receipt: null } });
    expect(await store.getRemoteDeviceReceipt(admissionWinner.id)).toBeNull();
    const originalInput = (await store.getTaskInput(`remote-input:${admissionWinner.id}`))!;
    expect(originalInput.body).toBe(admissionWinner.payload.text);
    sendFrame("command_cancel", { commandId: admissionWinner.id, payloadHash: admissionWinner.payloadHash }, "cancel-after-sql");
    await expect.poll(() => received.find(frame => frame.requestId === "cancel-after-sql"), { timeout: 3000 })
      .toMatchObject({ type: "command_cancel_result", payload: { cancelled: false,
        receipt: { state: "admitted", inputId: originalInput.id, localSessionId: session.id } } });
    expect(await store.getRemoteDeviceCancellation(admissionWinner.id)).toBeNull();
    afterAdmission.release();
    await expect.poll(() => received.find(frame => frame.type === "receipt" && frame.payload.id === admissionWinner.id), { timeout: 3000 })
      .toMatchObject({ payload: { state: "admitted", inputId: originalInput.id } });
    sendFrame("command", admissionWinner);
    await expect.poll(() => received.filter(frame => frame.type === "receipt" && frame.payload.id === admissionWinner.id).length, { timeout: 3000 }).toBe(2);
    expect(admissionAttempts.get(admissionWinner.id)).toBe(1);
    expect(await store.getTaskInput(originalInput.id)).toEqual(originalInput);
    expect((await store.taskInputsForSession(session.id, { limit: 10 })).map(input => input.id)).toEqual([originalInput.id]);
    expect((await store.getSession(session.id))?.metadata?.ponderLocalOwner).toEqual(owner);
    // The query's real SQLite reads can capture absence, then execution commits
    // and leaves the lane before those reads return. Its initial pending state
    // must still prevent a false "not admitted" reconciliation response.
    const settlingDuringQuery = await command(session.id);
    const beforeQueryAdmission = gate();
    const afterQueryRead = gate();
    const settlingExecutor = createRemoteCommandExecutor({ store, inspect, interrupt: async () => null,
      admit: async input => { await beforeQueryAdmission.wait(); return store.admitTaskInput(input); } });
    executeCommand = settlingExecutor;
    sendFrame("command", settlingDuringQuery);
    await expect.poll(() => beforeQueryAdmission.entered, { timeout: 3000 }).toBe(true);
    const getInput = store.getTaskInput.bind(store);
    const delayedInputRead = vi.spyOn(store, "getTaskInput").mockImplementation(async id => {
      const captured = await getInput(id);
      if (id === `remote-input:${settlingDuringQuery.id}`) await afterQueryRead.wait();
      return captured;
    });
    sendFrame("receipt_query", { commandId: settlingDuringQuery.id, payloadHash: settlingDuringQuery.payloadHash }, "settled-during-query");
    await expect.poll(() => afterQueryRead.entered, { timeout: 3000 }).toBe(true);
    beforeQueryAdmission.release();
    await expect.poll(() => received.find(frame => frame.type === "receipt" && frame.payload.id === settlingDuringQuery.id), { timeout: 3000 })
      .toMatchObject({ payload: { state: "admitted", inputId: `remote-input:${settlingDuringQuery.id}` } });
    afterQueryRead.release();
    await expect.poll(() => received.find(frame => frame.requestId === "settled-during-query"), { timeout: 3000 })
      .toMatchObject({ type: "receipt_query_result", payload: { notAdmitted: false, receipt: null, cancelled: false } });
    delayedInputRead.mockRestore();
    expect(await store.getTaskInput(`remote-input:${settlingDuringQuery.id}`)).toMatchObject({ body: settlingDuringQuery.payload.text });
    executeCommand = invalidCommand;
    // A stale hosted patch base must replace the directory without advancing
    // an unacknowledged base, and retirement must explicitly remove the source.
    rejectNextPatch = true;
    const updated = await sessions.patchSession(session.id, {
      title: "Changed owner-visible title",
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
    // Seed while notifications are paused; retry below publishes one complete
    // durable snapshot rather than repeatedly rebuilding a growing directory.
    seedingBulkCatalog = true;
    for (let index = 0; index < 650; index++) {
      await sessions.createUserSession({
        provider: "codex",
        title: `${index}:` + "x".repeat(990),
        cwd: directory,
        workspaceName: "w".repeat(990),
      });
    }
    seedingBulkCatalog = false;
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
    // Discovery cannot claim old OpenPond work. Only a fresh, provider-qualified
    // explicit choice persists the captured owner; another account's work stays private.
    const olderOpenPond = await sessions.createSession({ provider: "openpond", experience: "development",
      title: "Older OpenPond task", cwd: directory });
    const foreignOpenPond = await sessions.createSession({ provider: "openpond", title: "Other account task", cwd: directory });
    const foreignOwner = { ...owner, ownerUserId: "another-owner" };
    await store.updateSession(foreignOpenPond.id, value => ({ ...value,
      metadata: { ...value.metadata, ponderLocalOwner: foreignOwner } }));
    const ownershipChoices = await manager.settings("status") as { unresolvedTasks: Array<{ id: string; revision: string }> };
    const oldOpenPondChoice = ownershipChoices.unresolvedTasks.find(task => task.id === olderOpenPond.id)!;
    expect(oldOpenPondChoice).toBeDefined();
    expect(ownershipChoices.unresolvedTasks.some(task => task.id === foreignOpenPond.id)).toBe(false);
    expect((await store.getSession(olderOpenPond.id))?.metadata?.ponderLocalOwner).toBeUndefined();
    openPondEnabled = false;
    await expect(manager.settings("attach", { sessionId: olderOpenPond.id,
      expectedRevision: oldOpenPondChoice.revision })).rejects.toThrow("Enable OpenPond in Providers");
    expect((await store.getSession(olderOpenPond.id))?.metadata?.ponderLocalOwner).toBeUndefined();
    openPondEnabled = true;
    await manager.settings("attach", { sessionId: olderOpenPond.id, expectedRevision: oldOpenPondChoice.revision });
    expect((await store.getSession(olderOpenPond.id))?.metadata?.ponderLocalOwner).toEqual(owner);
    await expect(manager.settings("attach", { sessionId: foreignOpenPond.id,
      expectedRevision: oldOpenPondChoice.revision })).rejects.toThrow("remote_local_attachment_not_eligible");
    expect((await store.getSession(foreignOpenPond.id))?.metadata?.ponderLocalOwner).toEqual(foreignOwner);
    await expect(manager.settings("retry")).rejects.toThrow(
      "remote_access_off",
    );
    // A routine Off reconnect can finish during authentication without changing
    // the account. A real authority write must still invalidate the same read.
    const holdSettings = async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      pauseAccountStatus = async () => { entered(); await held; };
      const result = manager.settings("status");
      await started;
      return { result, release };
    };
    const authorityWrites = vi.spyOn(store, "setRemoteDeviceAuthority");
    const reconnectRead = await holdSettings();
    manager.wake();
    await expect.poll(() => authorityWrites.mock.calls.length).toBeGreaterThan(0);
    reconnectRead.release();
    await expect(reconnectRead.result).resolves.toMatchObject({ state: "off" });
    authorityWrites.mockRestore();
    const changingRead = await holdSettings();
    const rejectedRead = expect(changingRead.result).rejects.toThrow("remote_account_changing");
    await manager.beforeAuthorityChange();
    changingRead.release();
    await rejectedRead;
    manager.afterAuthorityChange();
    // Account scope changes revoke the old socket before saving preferences.
    // Reconnects wait for persistence. Off follows the account/profile across
    // personal and workspace selection while task/device identities stay scoped.
    const originalOwner = owner;
    const changeAuthority = createAccountAuthorityChange({
      before: manager.beforeAuthorityChange,
      after: () => manager.afterAuthorityChange(),
    });
    const previousHellos = received.filter(frame => frame.type === "hello").length;
    await changeAuthority(async () => {
      manager.wake();
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(manager.settings("status")).rejects.toThrow("remote_account_changing");
      expect(received.filter(frame => frame.type === "hello")).toHaveLength(previousHellos);
      owner = { ...owner, teamId: teamId === null ? "team" : null };
    });
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("off");
    expect(received.filter(frame => frame.type === "hello")).toHaveLength(previousHellos);
    expect(manager.status().owner?.teamId).toBe(owner.teamId);
    const reopened = await loadRemoteAccessPreference(directory);
    expect(reopened.enabled(originalOwner)).toBe(false);
    expect(reopened.enabled(owner)).toBe(false);
    expect(reopened.enabled({ ...owner, ownerUserId: "other-account" })).toBe(true);
    expect(reopened.enabled({ ...owner, profileId: "other-profile" })).toBe(true);
    // The existing active-scope Off entry is promoted once when captured, so an
    // upgrade does not accidentally turn on personal access after a scope change.
    const preferenceFile = path.join(directory, "remote-relay", "preference.json");
    const previousPreference = JSON.parse(await readFile(preferenceFile, "utf8"));
    await writeFile(preferenceFile, JSON.stringify({ ...previousPreference, disabled: [deviceOwnerKey(originalOwner)] }));
    const upgraded = await loadRemoteAccessPreference(directory);
    await upgraded.capture(originalOwner);
    expect((await loadRemoteAccessPreference(directory)).enabled(owner)).toBe(false);
    const taskAfterSelection = await sessions.createUserSession({ provider: "codex", title: "Task in the newly selected scope", cwd: directory });
    expect(taskAfterSelection.metadata?.ponderLocalOwner).toEqual(owner);
    expect((await store.getSession(session.id))?.metadata?.ponderLocalOwner).toEqual(originalOwner);
    await manager.setEnabled(true);
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("connected");
    await expect.poll(() => {
      const catalogs = received.filter(frame => frame.type === "catalog" && frame.payload.complete);
      return catalogs[catalogs.length - 1]?.payload.tasks.length;
    }, { timeout: 3000 }).toBe(1);
    expect((await loadRemoteAccessPreference(directory)).enabled(originalOwner)).toBe(true);
    expect((await store.getSession(session.id))?.metadata?.ponderLocalOwner).toEqual(originalOwner);
    expect((await store.getSession(unowned.id))?.metadata?.ponderLocalOwner).toBeUndefined();
    await expect(changeAuthority(async () => { throw new Error("Preference save failed"); })).rejects.toThrow("Preference save failed");
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("connected");
    await manager.setEnabled(false);
    await changeAuthority(async () => { owner = originalOwner; });
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("off");
    signedIn = false;
    expect(
      ((await manager.settings("status")) as { state: string }).state,
    ).toBe("signed_out");
    // Shutdown discards a waiting command but lets already-admitted work finish
    // its durable receipt. Neither result may be sent on a later connection.
    signedIn = true;
    await manager.setEnabled(true);
    await expect.poll(() => manager.status().state, { timeout: 3000 }).toBe("connected");
    const shutdownSession = await sessions.createUserSession({ provider: "codex", title: "Shutdown admission boundary", cwd: directory });
    const admittedAtShutdown = await command(shutdownSession.id);
    const queuedAtShutdown = await command(shutdownSession.id);
    const shutdownAdmission = gate();
    const shutdownOrder: string[] = [];
    const shutdownExecutor = createRemoteCommandExecutor({ store, inspect, interrupt: async () => null,
      admit: async input => {
        const accepted = await store.admitTaskInput(input);
        if ((input.payload.remoteDevice as RemoteDispatchCommand).id === admittedAtShutdown.id) await shutdownAdmission.wait();
        return accepted;
      } });
    executeCommand = async value => { shutdownOrder.push(value.id); return shutdownExecutor(value); };
    const shutdownConnection = [...server.clients].at(-1)!;
    const shutdownSend = (type: string, payload: unknown, requestId?: string) => shutdownConnection.send(JSON.stringify({
      protocolVersion: 1, deviceId, epoch: "epoch", fence: 1, type, payload, ...(requestId ? { requestId } : {}),
    }));
    shutdownSend("command", admittedAtShutdown);
    await expect.poll(() => shutdownAdmission.entered, { timeout: 3000 }).toBe(true);
    shutdownSend("command", queuedAtShutdown);
    shutdownSend("receipt_query", { commandId: queuedAtShutdown.id, payloadHash: queuedAtShutdown.payloadHash }, "queued-before-close");
    await expect.poll(() => received.find(frame => frame.requestId === "queued-before-close"), { timeout: 3000 })
      .toMatchObject({ type: "receipt_query_result", payload: { notAdmitted: false, receipt: null } });
    let closeFinished = false;
    const closing = manager.close().then(() => { closeFinished = true; });
    const shutdownInput = (await store.getTaskInput(`remote-input:${admittedAtShutdown.id}`))!;
    expect(closeFinished).toBe(false);
    expect(shutdownOrder).toEqual([admittedAtShutdown.id]);
    expect(await store.getTaskInput(`remote-input:${queuedAtShutdown.id}`)).toBeNull();
    shutdownAdmission.release();
    await closing;
    expect(await store.getRemoteDeviceReceipt(admittedAtShutdown.id)).toMatchObject({ state: "admitted", inputId: shutdownInput.id });
    expect(shutdownOrder).toEqual([admittedAtShutdown.id]);
    expect(received.some(frame => frame.type === "receipt" && frame.payload.id === admittedAtShutdown.id)).toBe(false);
    const recovery = createRemoteCommandExecutor({ store, inspect: async () => { throw new Error("Shutdown recovery must not inspect"); },
      admit: async () => { throw new Error("Shutdown recovery must not readmit"); }, interrupt: async () => null });
    expect((await recovery(admittedAtShutdown)).inputId).toBe(shutdownInput.id);
    expect(await store.getTaskInput(shutdownInput.id)).toEqual(shutdownInput);
    expect((await store.taskInputsForSession(shutdownSession.id, { limit: 10 })).map(input => input.id)).toEqual([shutdownInput.id]);
  } finally {
    for (const release of releaseCommands) release();
    await manager.close();
    for (const connection of server.clients) connection.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
