import { listenRemoteRelayEvents } from "./runtime-events.js";
import { Hello, Keys, type RemoteRelayDependencies, type Selected } from "./manager-types.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import WebSocket from "ws";
import { z } from "zod";
import {
  REMOTE_DEVICE_LIMITS,
  REMOTE_DEVICE_PROTOCOL_VERSION,
  type RemoteAccessAccountStatus,
  type RemoteAccessConnectionState,
  type RemoteAccessSettingsAction,
  type RemoteDevice,
  type RemoteDeviceFrame,
  type RemoteDispatchCommand,
  type Session,
} from "@openpond/contracts";
import { deviceOwnerKey, loadRemoteAccessPreference } from "./preference.js";
import { createRemoteDeviceClient, createSelectedRemoteClient } from "./client.js";
import {
  captureRemoteTaskCatalog,
  observeRemoteHistorySequence,
  remoteHistoryIncarnation,
} from "./catalog.js";
import {
  readRemoteHistory,
} from "./history.js";
import type { RemoteLocalAuthority } from "./admission.js";
import {
  localSessionMayResolveOwnership,
  localSessionOwnershipRevision,
} from "./session-ownership.js";
import { captureRemoteStarters } from "./starters.js";
import { uploadRemoteArtifact } from "./artifacts.js";

import { createCatalogPublication } from "./catalog-publication.js";
import {
  remoteCloseFailure,
  remoteReconnectDelay,
  type RemoteConnectionFailure,
} from "./connection-state.js";

/** One process owns the connection. Viewer presence never owns task execution. */
export function createRemoteRelayManager(deps: RemoteRelayDependencies) {
  let preference: Awaited<ReturnType<typeof loadRemoteAccessPreference>>;
  let selected: Selected | null = null;
  let socket: WebSocket | null = null;
  let device: RemoteDevice | null = null;
  let authority: RemoteLocalAuthority | null = null;
  let transportLease: z.infer<typeof Hello> | null = null;
  let serviceTrust: z.infer<typeof Keys> | null = null;
  let activeClient: ReturnType<typeof createRemoteDeviceClient> | null = null;
  let epoch: string | null = null;
  let closed = false;
  let generation = 0;
  let authorityChanging = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let catalogTimer: ReturnType<typeof setTimeout> | null = null;
  let unlisten: (() => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let state: RemoteAccessConnectionState = "offline";
  let accountPresentation: RemoteAccessAccountStatus = {
    state: "signed_out",
    account: null,
    team: null,
    webBaseUrl: null,
  };
  let failure: RemoteConnectionFailure | null = null;
  let reconnectAttempt = 0;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let catalogDirty = true;
  let publishedHistoryIncarnation = remoteHistoryIncarnation();
  let incomingBytes = 0;
  const callerRequests = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let connectionReady: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const subscriptions = new Map<string, Map<string, number>>();
  const serial = <T>(fn: () => Promise<T>) => {
    const value = queue.then(fn);
    queue = value.catch(() => undefined);
    return value;
  };
  const clientFor = (current: Selected) => createSelectedRemoteClient(deps.installation, current);
  const send = (frame: RemoteDeviceFrame) => {
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error("remote_connection_unavailable");
    const encoded = JSON.stringify({
      ...(device ? { deviceId: device.id } : {}),
      ...(epoch ? { epoch } : {}),
      ...(transportLease ? { fence: transportLease.fence } : {}),
      ...frame,
    });
    if (
      Buffer.byteLength(encoded) > REMOTE_DEVICE_LIMITS.frameBytes ||
      socket.bufferedAmount + Buffer.byteLength(encoded) >
        REMOTE_DEVICE_LIMITS.socketQueueBytes
    )
      throw new Error("remote_connection_backpressure");
    socket.send(encoded);
  };
  const publication = createCatalogPublication((page) =>
    send({ protocolVersion: 1, type: "catalog", payload: page }),
  );
  async function disconnect(cause?: RemoteConnectionFailure) {
    if (
      cause &&
      (failure?.state !== "update_required" ||
        cause.state === "update_required")
    )
      failure = cause;
    if (failure?.state === "update_required" && timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    if (catalogTimer) clearTimeout(catalogTimer);
    catalogTimer = null;
    generation++;
    catalogDirty = true;
    publication.reset();
    authority = null;
    epoch = null;
    activeClient = null;
    subscriptions.clear();
    transportLease = null;
    rejectReady?.(new Error("remote_connection_lost"));
    connectionReady = null;
    resolveReady = null;
    rejectReady = null;
    for (const request of callerRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("remote_connection_lost"));
    }
    callerRequests.clear();
    const previous = socket;
    socket = null;
    previous?.close(1000, "authority_changed");
    await deps.store.setRemoteDeviceAuthority(null);
    state =
      selected && preference && !preference.enabled(selected.owner)
        ? "off"
        : (failure?.state ?? "offline");
  }
  async function sessions() {
    const rows: Session[] = [];
    for (const shell of await deps.store.sessionShells()) {
      const session = await deps.store.getSession(shell.id);
      if (session) rows.push(session);
    }
    return rows;
  }
  async function catalog() {
    if (!selected || !authority || !preference.enabled(selected.owner)) return;
    if (observeRemoteHistorySequence(await deps.store.latestEventSequence())) {
      catalogDirty = true;
    }
    if (publishedHistoryIncarnation !== remoteHistoryIncarnation()) {
      catalogDirty = true;
    }
    if (!catalogDirty) return;
    catalogDirty = false;
    const allSessions = await sessions();
    const tasks = await captureRemoteTaskCatalog({
      owner: selected.owner,
      sessions: allSessions,
      inspect: deps.inspect,
      approvals: await deps.store.pendingApprovals(),
      latestTurn: (id) => deps.store.latestTurnForSession(id),
    });
    for (const task of tasks) {
      const session = allSessions.find(
        (session) => session.id === task.localSessionId,
      )!;
      task.capabilities.artifacts = session.experience === "work";
      const last = await deps.store.runtimeEventPageRows({
        sessionId: session.id,
        afterSequence: 0,
        beforeSequence: (await deps.store.latestEventSequence()) + 1,
        limit: 1,
      });
      task.lastEventSequence = last.entries[0]?.sequence ?? 0;
    }
    const starters = [
      ...captureRemoteStarters(allSessions, selected.owner).values(),
    ].map((starter) => starter.target);
    try {
      await publication.publish(tasks, starters);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "remote_catalog_resync_required"
      ) {
        catalogDirty = true;
        await publication.publish(tasks, starters);
      } else throw error;
    }
    publishedHistoryIncarnation = remoteHistoryIncarnation();
  }
  async function connect(reenable = false) {
    if (closed || authorityChanging || failure?.state === "update_required") return;
    const accountGeneration = generation;
    const next = await deps.current();
    const presentation = await deps.accountStatus();
    if (next) await preference.capture(next.owner);
    if (authorityChanging || accountGeneration !== generation || closed) return;
    accountPresentation = presentation;
    if (
      selected &&
      (!next ||
        deviceOwnerKey(next.owner) !== deviceOwnerKey(selected.owner) ||
        next.credentialKey !== selected.credentialKey)
    ) {
      await disconnect();
      device = null;
    }
    selected = next;
    const requestOnly = !!next && !preference.enabled(next.owner);
    if (!next || (requestOnly && !deps.caller?.needsConnection())) {
      await disconnect();
      return;
    }
    for (const [taskId, viewers] of subscriptions) {
      for (const [viewerId, expiresAt] of viewers)
        if (expiresAt <= Date.now()) viewers.delete(viewerId);
      if (viewers.size === 0) subscriptions.delete(taskId);
    }
    if (socket) {
      if (transportLease && activeClient && device) {
        serviceTrust = Keys.parse(
          await activeClient.request({ path: "/remote-devices/service-keys" }),
        );
        const ticket = z.object({ ticket: z.string() }).parse(
          await activeClient.signed("/v1/remote-devices/connection-tickets", {
            role: "device",
            deviceId: device.id,
            client: "desktop",
            mode: requestOnly ? "request" : "remote",
            ...(deps.caller?.requestAuthority(device.id, activeClient.runtimeId)
              ? {
                  requestAuthority: deps.caller.requestAuthority(
                    device.id,
                    activeClient.runtimeId,
                  ),
                }
              : {}),
          }),
        );
        send({
          protocolVersion: 1,
          type: "renew",
          payload: { ticket: ticket.ticket },
        });
        send({ protocolVersion: 1, type: "heartbeat" });
        await catalog();
      }
      return;
    }
    state = "connecting";
    const attempt = generation;
    const client = clientFor(next);
    let enrollment: { device: RemoteDevice };
    try {
      enrollment = (await client.signed("/v1/remote-devices/enroll", {
        publicKey: deps.installation.publicKey,
        name: os.hostname(),
        platform: process.platform,
        enabled: !requestOnly,
        ...(requestOnly ? { requestOnly: true } : {}),
        ...(reenable ? { reenable: true } : {}),
      })) as { device: RemoteDevice };
    } catch (error) {
      if (String(error).includes("deliberate_local_reenable_required")) {
        await preference.set(next.owner, false);
        state = "off";
        return;
      }
      throw error;
    }
    const trusted = Keys.parse(
      await client.request({ path: "/remote-devices/service-keys" }),
    );
    serviceTrust = trusted;
    const ticket = z
      .object({ ticket: z.string(), connectUrl: z.string().url() })
      .parse(
        await client.signed("/v1/remote-devices/connection-tickets", {
          role: "device",
          deviceId: enrollment.device.id,
          client: "desktop",
          mode: requestOnly ? "request" : "remote",
          ...(deps.caller?.requestAuthority(
            enrollment.device.id,
            client.runtimeId,
          )
            ? {
                requestAuthority: deps.caller.requestAuthority(
                  enrollment.device.id,
                  client.runtimeId,
                ),
              }
            : {}),
        }),
      );
    if (attempt !== generation || closed) return;
    device = enrollment.device;
    await preference.setDeviceId(next.owner, device.id);
    activeClient = client;
    const connection = new WebSocket(ticket.connectUrl, {
      maxPayload: REMOTE_DEVICE_LIMITS.frameBytes,
    });
    connectionReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void connectionReady.catch(() => undefined);
    socket = connection;
    handshakeTimer = setTimeout(() => {
      if (socket === connection && !transportLease)
        void disconnect({
          state: "reconnecting",
          reason: "authentication_timeout",
        }).then(schedule);
    }, 6_000);
    handshakeTimer.unref();
    connection.on("open", () => {
      if (socket === connection)
        send({
          protocolVersion: 1,
          type: "hello",
          payload: { ticket: ticket.ticket },
        });
    });
    connection.on("message", (raw) => {
      // Publication waits inside the serial queue. Lease-bound ACKs must resolve
      // that wait directly; placing them on the same queue would deadlock it.
      try {
        const acknowledgement = JSON.parse(raw.toString()) as RemoteDeviceFrame;
        const resync =
          acknowledgement.type === "error" &&
          (acknowledgement.payload as { error?: string })?.error ===
            "catalog_resync_required";
        if (acknowledgement.type === "catalog_ack" || resync) {
          if (
            socket !== connection ||
            attempt !== generation ||
            !transportLease
          )
            return;
          if (
            acknowledgement.protocolVersion !==
              REMOTE_DEVICE_PROTOCOL_VERSION ||
            acknowledgement.deviceId !== device?.id ||
            acknowledgement.epoch !== transportLease.epoch ||
            acknowledgement.fence !== transportLease.fence
          )
            throw new Error("remote_catalog_ack_authority_changed");
          if (resync) {
            const payload = z
              .object({ catalogRevision: z.number().int().nonnegative() })
              .parse(acknowledgement.payload);
            publication.resync(payload.catalogRevision);
            catalogDirty = true;
          } else publication.acknowledge(acknowledgement.payload);
          return;
        }
      } catch (error) {
        deps.warn(
          `Remote relay acknowledgement: ${error instanceof Error ? error.name : "invalid_frame"}`,
        );
        void disconnect({
          state: "reconnecting",
          reason: "connection_failed",
        }).then(schedule);
        return;
      }
      const bytes = Buffer.byteLength(raw.toString());
      if (incomingBytes + bytes > REMOTE_DEVICE_LIMITS.socketQueueBytes) {
        void disconnect({
          state: "reconnecting",
          reason: "relay_backpressure",
        }).then(schedule);
        return;
      }
      incomingBytes += bytes;
      void serial(async () => {
        if (socket !== connection || attempt !== generation) return;
        const frame = JSON.parse(raw.toString()) as RemoteDeviceFrame;
        if (frame.protocolVersion !== REMOTE_DEVICE_PROTOCOL_VERSION) {
          await disconnect({
            state: "update_required",
            reason: "protocol_unsupported",
          });
          return;
        }
        if (
          frame.type === "hello" ||
          frame.type === "heartbeat" ||
          frame.type === "renew"
        ) {
          const hello = Hello.parse(frame.payload);
          if (frame.type === "hello") {
            const advertised = z
              .object({
                catalogRevision: z.number().int().nonnegative(),
                minimumSupportedProtocolVersion: z.number().int().positive(),
                supportedProtocolVersion: z.number().int().positive(),
              })
              .parse(frame.payload);
            if (
              advertised.minimumSupportedProtocolVersion >
                REMOTE_DEVICE_PROTOCOL_VERSION ||
              advertised.supportedProtocolVersion !==
                REMOTE_DEVICE_PROTOCOL_VERSION
            ) {
              await disconnect({
                state: "update_required",
                reason: "protocol_unsupported",
                minimumSupportedProtocolVersion:
                  advertised.minimumSupportedProtocolVersion,
              });
              return;
            }
            publication.reset(advertised.catalogRevision);
          }
          if (hello.deviceId !== device?.id)
            throw new Error("remote_device_identity_changed");
          epoch = hello.epoch;
          transportLease = hello;
          authority = requestOnly
            ? null
            : {
                ...hello,
                owner: next.owner,
                publicKeys: serviceTrust?.keys ?? [],
              };
          await deps.store.setRemoteDeviceAuthority(authority);
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          failure = null;
          reconnectAttempt = 0;
          resolveReady?.();
          resolveReady = null;
          if (frame.type === "hello") await catalog();
          state = requestOnly ? "off" : "connected";
        } else if (frame.type === "error") {
          const problem = z
            .object({
              error: z.string(),
              minimumSupportedProtocolVersion: z
                .number()
                .int()
                .positive()
                .optional(),
            })
            .parse(frame.payload);
          if (problem.error === "protocol_unsupported") {
            await disconnect({
              state: "update_required",
              reason: problem.error,
              minimumSupportedProtocolVersion:
                problem.minimumSupportedProtocolVersion,
            });
          } else throw new Error("remote_relay_rejected_frame");
        } else if (frame.type === "revoked") {
          await preference.set(next.owner, false);
          await disconnect();
        } else if (frame.type === "drain") {
          await disconnect({
            state: "reconnecting",
            reason: "connection_lost",
          });
          schedule();
        } else if (
          frame.type === "subscribe" ||
          frame.type === "history_request"
        ) {
          if (!authority) throw new Error("remote_authority_unavailable");
          const request = z
            .object({
              taskId: z.string(),
              viewerId: z.string().optional(),
              cursor: z.unknown().optional(),
            })
            .parse(frame.payload);
          if (frame.type === "subscribe") {
            if (!request.viewerId)
              throw new Error("remote_viewer_identity_required");
            if (
              !subscriptions.has(request.taskId) &&
              subscriptions.size >= REMOTE_DEVICE_LIMITS.deviceSubscriptions
            )
              throw new Error("remote_subscription_limit");
            const viewers =
              subscriptions.get(request.taskId) ?? new Map<string, number>();
            const renewed = viewers.has(request.viewerId);
            if (viewers.size >= 100 && !renewed)
              throw new Error("remote_viewer_limit");
            viewers.set(request.viewerId, Date.now() + 75_000);
            subscriptions.set(request.taskId, viewers);
            if (!frame.requestId && request.cursor === undefined) return;
          }
          let cursor =
            typeof request.cursor === "string" ? request.cursor : null;
          if (request.cursor && typeof request.cursor === "object") {
            const replay = z
              .object({
                historyGeneration: z.string(),
                sequence: z.number().int().nonnegative(),
              })
              .parse(request.cursor);
            cursor = Buffer.from(
              JSON.stringify({
                generation: replay.historyGeneration,
                taskId: request.taskId,
                after: replay.sequence,
                watermark: await deps.store.latestEventSequence(),
                snapshotId: randomUUID(),
              }),
            ).toString("base64url");
          }
          const page = await readRemoteHistory({
            store: deps.store,
            owner: next.owner,
            taskId: request.taskId,
            cursor,
            outputs: deps.outputs,
          });
          send({
            protocolVersion: 1,
            type: "snapshot",
            taskId: request.taskId,
            requestId: frame.requestId,
            payload: page,
          });
        } else if (frame.type === "unsubscribe") {
          const request = z
            .object({ taskId: z.string(), viewerId: z.string() })
            .parse(frame.payload);
          const viewers = subscriptions.get(request.taskId);
          viewers?.delete(request.viewerId);
          if (viewers?.size === 0) subscriptions.delete(request.taskId);
        } else if (frame.type === "receipt_query") {
          const request = z
            .object({ commandId: z.string(), payloadHash: z.string() })
            .parse(frame.payload);
          const receipt = await deps.store.getRemoteDeviceReceipt(
            request.commandId,
          );
          const input = await deps.store.getTaskInput(
            `remote-input:${request.commandId}`,
          );
          const admitted = input?.payload.remoteDevice as
            | RemoteDispatchCommand
            | undefined;
          const cancellation = await deps.store.getRemoteDeviceCancellation(
            request.commandId,
          );
          if (cancellation && cancellation.payload_hash !== request.payloadHash)
            throw new Error("remote_command_identity_changed");
          if (
            (receipt && receipt.payloadHash !== request.payloadHash) ||
            (admitted && admitted.payloadHash !== request.payloadHash)
          )
            throw new Error("remote_command_identity_changed");
          send({
            protocolVersion: 1,
            type: "receipt_query_result",
            requestId: frame.requestId,
            payload: {
              commandId: request.commandId,
              payloadHash: request.payloadHash,
              receipt:
                receipt ??
                (input && admitted
                  ? {
                      id: admitted.id,
                      deviceId: admitted.deviceId,
                      state: "admitted",
                      revision: 2,
                      payloadHash: admitted.payloadHash,
                      action: admitted.action,
                      targetId: admitted.targetId,
                      localSessionId: input.sessionId,
                      inputId: input.id,
                      turnId: input.turnId,
                      createdAt: input.createdAt,
                      expiresAt: admitted.deadline,
                    }
                  : null),
              notAdmitted: !receipt && !input,
              cancelled: !!cancellation,
            },
          });
        } else if (frame.type === "command_cancel") {
          const request = z
            .object({ commandId: z.string(), payloadHash: z.string() })
            .parse(frame.payload);
          const result = await deps.store.cancelRemoteDeviceCommand(
            request.commandId,
            request.payloadHash,
          );
          send({
            protocolVersion: 1,
            type: "command_cancel_result",
            requestId: frame.requestId,
            payload: { ...request, ...result },
          });
        } else if (frame.type === "caller_offers")
          deps.caller?.receiveOffers(frame.payload);
        else if (frame.type === "caller_result") {
          const request = frame.requestId
            ? callerRequests.get(frame.requestId)
            : null;
          if (!request) return;
          const reply = z
            .object({
              result: z.unknown().optional(),
              error: z.string().optional(),
            })
            .parse(frame.payload);
          callerRequests.delete(frame.requestId!);
          clearTimeout(request.timer);
          if (reply.error) request.reject(new Error(reply.error));
          else request.resolve(reply.result);
        } else if (frame.type === "artifact_request") {
          try {
            const result = await uploadRemoteArtifact({
              payload: frame.payload,
              owner: next.owner,
              uploadOrigins: serviceTrust?.artifactUploadOrigins ?? [],
              session: (id) => deps.store.getSession(id),
              outputs: deps.outputs,
              read: deps.readOutput,
              stillCurrent: () =>
                socket === connection && generation === attempt && !!authority,
            });
            send({
              protocolVersion: 1,
              type: "artifact_result",
              requestId: frame.requestId,
              payload: result,
            });
          } catch (error) {
            send({
              protocolVersion: 1,
              type: "artifact_result",
              requestId: frame.requestId,
              payload: {
                artifactId: (frame.payload as { artifactId?: string })
                  .artifactId,
                error:
                  error instanceof Error
                    ? error.message
                    : "remote_artifact_failed",
              },
            });
          }
        } else if (frame.type === "command") {
          const command = frame.payload as RemoteDispatchCommand;
          try {
            const receipt = await deps.execute(command);
            send({ protocolVersion: 1, type: "receipt", payload: receipt });
          } catch (error) {
            const admitted = await deps.store.getRemoteDeviceReceipt(
              command.id,
            );
            if (admitted) {
              send({
                protocolVersion: 1,
                type: "receipt",
                payload: { ...admitted, state: "reconciling" },
              });
              return;
            }
            send({
              protocolVersion: 1,
              type: "receipt",
              payload: {
                id: command.id,
                deviceId: command.deviceId,
                payloadHash: command.payloadHash,
                action: command.action,
                targetId: command.targetId,
                state: "rejected",
                revision: 2,
                error:
                  error instanceof z.ZodError
                    ? "remote_command_configuration_invalid"
                    : error instanceof Error &&
                        /^remote_[a-z0-9_]+$/.test(error.message)
                      ? error.message
                      : "remote_command_failed",
                createdAt: new Date().toISOString(),
                expiresAt: command.deadline,
              },
            });
          }
        }
      })
        .catch((error) => {
          deps.warn(
            `Remote relay frame: ${error instanceof Error ? error.name : "invalid_frame"}`,
          );
          void disconnect({
            state: "reconnecting",
            reason: "connection_failed",
          }).then(schedule);
        })
        .finally(() => {
          incomingBytes -= bytes;
        });
    });
    connection.on("close", (code, reason) => {
      if (socket !== connection) return;
      const cause = remoteCloseFailure(code, reason.toString());
      if (cause.state === "off") void preference.set(next.owner, false);
      void disconnect(cause).then(schedule);
    });
    connection.on("error", (error) =>
      deps.warn(`Remote relay connection: ${error.name}`),
    );
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (closed || failure?.state === "update_required") return;
    const retrying =
      !!selected &&
      (preference.enabled(selected.owner) ||
        !!deps.caller?.needsConnection()) &&
      !socket;
    const delay = retrying ? remoteReconnectDelay(reconnectAttempt++) : 15_000;
    timer = setTimeout(() => {
      timer = null;
      void serial(connect)
        .catch((error) => {
          state = "reconnecting";
          failure = { state, reason: "connection_failed" };
          deps.warn(
            `Remote relay: ${error instanceof Error ? error.name : "connection_failed"}`,
          );
        })
        .finally(schedule);
    }, delay);
    timer.unref();
  }
  function scheduleCatalog() {
    catalogDirty = true;
    if (closed || catalogTimer || !authority) return;
    catalogTimer = setTimeout(() => {
      catalogTimer = null;
      void serial(catalog).catch(() => {
        catalogDirty = true;
        void disconnect({
          state: "reconnecting",
          reason: "connection_failed",
        }).then(schedule);
      });
    }, 100);
    catalogTimer.unref();
  }
  return {
    async start() {
      preference = await loadRemoteAccessPreference(deps.storeDir);
      await deps.store.initializeRemoteDeviceStore();
      unlisten = listenRemoteRelayEvents({ deps, current: () => ({ selected, authority }),
        subscriptions, scheduleCatalog, catalog, send, serial, disconnect, schedule });
      await serial(connect).catch((error) =>
        deps.warn(
          `Remote relay startup: ${error instanceof Error ? error.name : "connection_failed"}`,
        ),
      );
      schedule();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
      await disconnect();
      await queue;
    },
    async beforeAuthorityChange() {
      authorityChanging = true;
      failure = null;
      await disconnect();
      if (selected) await preference.capture(selected.owner);
      selected = null;
      device = null;
      state = "offline";
    },
    afterAuthorityChange() {
      authorityChanging = false;
      this.wake();
    },
    wake() {
      void serial(connect).catch((error) =>
        deps.warn(
          `Remote relay wake: ${error instanceof Error ? error.name : "connection_failed"}`,
        ),
      ).finally(schedule);
    },
    async callerRequest(payload: unknown) {
      if (callerRequests.size >= 32)
        throw new Error("ponder_relay_request_limit");
      await serial(connect);
      await connectionReady;
      if (!transportLease)
        throw new Error("ponder_relay_connection_unavailable");
      const requestId = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          callerRequests.delete(requestId);
          reject(new Error("ponder_relay_request_timeout"));
        }, 30_000);
        timer.unref();
        callerRequests.set(requestId, { resolve, reject, timer });
        try {
          send({
            protocolVersion: 1,
            type: "caller_request",
            requestId,
            payload,
          });
        } catch (error) {
          clearTimeout(timer);
          callerRequests.delete(requestId);
          reject(error);
        }
      });
    },
    status() {
      const visibleState = selected ? state : "signed_out";
      return {
        state: visibleState,
        enabled: selected ? preference.enabled(selected.owner) : false,
        device,
        owner: selected?.owner ?? null,
        account: accountPresentation.account,
        team: accountPresentation.team,
        webBaseUrl: accountPresentation.webBaseUrl,
        reason: failure?.reason ?? null,
        minimumSupportedProtocolVersion:
          failure?.minimumSupportedProtocolVersion ?? null,
        supportedProtocolVersion: REMOTE_DEVICE_PROTOCOL_VERSION,
      };
    },
    async settings(
      action: RemoteAccessSettingsAction,
      payload?: unknown,
    ): Promise<unknown> {
      if (authorityChanging) throw new Error("remote_account_changing");
      const accountGeneration = generation;
      const presentation = await deps.accountStatus();
      const current = await deps.current();
      if (current) await preference.capture(current.owner);
      if (authorityChanging || accountGeneration !== generation) throw new Error("remote_account_changing");
      accountPresentation = presentation;
      if (!current) {
        await disconnect();
        selected = null;
        device = null;
        return { ...this.status(), devices: [], unresolvedTasks: [] };
      }
      if (
        selected &&
        deviceOwnerKey(selected.owner) !== deviceOwnerKey(current.owner)
      ) {
        await disconnect();
        selected = current;
        device = null;
      }
      if (action === "enable" || action === "disable")
        await this.setEnabled(action === "enable");
      if (action === "retry") {
        if (!preference.enabled(current.owner))
          throw new Error("remote_access_off");
        failure = null;
        reconnectAttempt = 0;
        await disconnect();
        selected = current;
        await serial(connect);
        schedule();
      }
      if (action === "attach") {
        const input = z
          .object({
            sessionId: z.string(),
            expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(payload);
        const attempt = generation;
        await deps.store.attachLocalSessionOwner({
          ...input,
          owner: current.owner,
          assertCurrent: () => {
            if (attempt !== generation || closed)
              throw new Error("remote_account_changed");
          },
        });
        catalogDirty = true;
        if (authority) await catalog();
      }
      if (
        action === "rename" ||
        action === "remove" ||
        action === "disable-device"
      ) {
        const input = z
          .object({
            deviceId: z.string().uuid(),
            revision: z.number().int().positive(),
            name: z.string().min(1).max(200).optional(),
          })
          .strict()
          .parse(payload);
        const source = preference.deviceId(current.owner);
        if (!source) throw new Error("remote_device_not_enrolled");
        const changed = (await clientFor(current).signed(
          "/v1/remote-devices/device-management",
          {
            deviceId: source,
            action: action === "disable-device" ? "disable" : action,
            targetDeviceId: input.deviceId,
            revision: input.revision,
            ...(input.name ? { name: input.name } : {}),
          },
        )) as { device: RemoteDevice };
        if (input.deviceId === device?.id) device = changed.device;
        if (
          ["remove", "disable-device"].includes(action) &&
          input.deviceId === device?.id
        ) {
          await preference.set(current.owner, false);
          await disconnect();
        }
      }
      const source = preference.deviceId(current.owner);
      const devices = source
        ? ((await clientFor(current).signed(
            "/v1/remote-devices/device-management",
            { deviceId: source, action: "list" },
          )) as { devices: RemoteDevice[] })
        : { devices: [] };
      device = devices.devices.find((value) => value.id === source) ?? device;
      const unresolvedTasks = [];
      for (const session of await sessions()) {
        if (!localSessionMayResolveOwnership(session)) continue;
        const target = await deps.inspect(session.id);
        if (target.canSendFollowup)
          unresolvedTasks.push({
            id: session.id,
            title: session.title,
            revision: localSessionOwnershipRevision(
              session,
              target.latestTurnId,
            ),
          });
      }
      return { ...this.status(), devices: devices.devices, unresolvedTasks };
    },
    async setEnabled(enabled: boolean) {
      if (authorityChanging) throw new Error("remote_account_changing");
      failure = null;
      reconnectAttempt = 0;
      const accountGeneration = generation;
      const current = await deps.current();
      if (authorityChanging || accountGeneration !== generation) throw new Error("remote_account_changing");
      if (!current) throw new Error("Sign in to your OpenPond account first.");
      await preference.set(current.owner, enabled);
      if (authorityChanging || accountGeneration !== generation) throw new Error("remote_account_changing");
      await disconnect();
      if (authorityChanging || generation !== accountGeneration + 1) throw new Error("remote_account_changing");
      selected = current;
      if (!enabled && device)
        await clientFor(current).signed(
          "/v1/remote-devices/device-management",
          {
            deviceId: device.id,
            targetDeviceId: device.id,
            action: "disable",
            revision: device.revision,
          },
        );
      if (enabled) await serial(() => connect(true));
      schedule();
      return this.status();
    },
  };
}
