import {
  REMOTE_DEVICE_LIMITS,
  type RemoteDeviceFrame,
} from "@openpond/contracts";
import {
  projectRemoteEvent,
  projectRemoteEventChunks,
  normalizeRemoteEventTurn,
} from "./history.js";
import { remoteHistoryGeneration } from "./catalog.js";
import type { RemoteLocalAuthority } from "./admission.js";
import type { RemoteRelayDependencies, Selected } from "./manager-types.js";

export function listenRemoteRelayEvents(input: {
  deps: RemoteRelayDependencies;
  current(): {
    selected: Selected | null;
    authority: RemoteLocalAuthority | null;
  };
  subscriptions: Map<string, Map<string, number>>;
  scheduleCatalog(): void;
  catalog(): Promise<void>;
  send(frame: RemoteDeviceFrame): void;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  disconnect(
    failure: import("./connection-state.js").RemoteConnectionFailure,
  ): Promise<void>;
  schedule(): void;
}) {
  const {
    deps,
    current,
    subscriptions,
    scheduleCatalog,
    catalog,
    send,
    serial,
    disconnect,
    schedule,
  } = input;
  let eventBytes = 0;
  return deps.listen((event) => {
    const semanticChange = [
      "session.started",
      "session.updated",
      "session.title.updated",
      "session.closed",
      "turn.started",
      "turn.completed",
      "turn.failed",
      "turn.interrupted",
      "approval.requested",
      "approval.resolved",
    ].includes(event.name);
    if (semanticChange) scheduleCatalog();
    const sessionId = event.sessionId;
    if (!current().authority || !sessionId || !subscriptions.has(sessionId))
      return;
    const item = projectRemoteEvent(event, event.sequence ?? 0);
    if (!item) return;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (eventBytes + bytes > REMOTE_DEVICE_LIMITS.socketQueueBytes) {
      void disconnect({
        state: "reconnecting",
        reason: "relay_backpressure",
      }).then(schedule);
      return;
    }
    eventBytes += bytes;
    void serial(async () => {
      const { selected, authority } = current();
      if (!selected || !authority || !subscriptions.has(sessionId)) return;
      const session = await deps.store.getSession(sessionId);
      if (!session || current().authority !== authority || current().selected !== selected) return;
      const { deviceOwnsLocalSession } = await import("./local-scope.js");
      if (!deviceOwnsLocalSession(session, selected.owner)) return;
      if (semanticChange) await catalog();
      if (event.name === "turn.completed")
        item.artifactIds = (await deps.outputs(session))
          .filter((output) => output.sourceTurnId === event.turnId)
          .map((output) => output.id)
          .slice(0, 100);
      for (const part of projectRemoteEventChunks(
        await normalizeRemoteEventTurn(deps.store, event),
        event.sequence ?? 0,
      )) {
        if (current().authority !== authority || current().selected !== selected) return;
        if (item.artifactIds) part.artifactIds = item.artifactIds;
        send({
          protocolVersion: 1,
          type: "events",
          taskId: session.id,
          payload: {
            historyGeneration: remoteHistoryGeneration(session),
            items: [part],
          },
        });
      }
    })
      .catch(() => {
        void disconnect({
          state: "reconnecting",
          reason: "connection_failed",
        }).then(schedule);
      })
      .finally(() => {
        eventBytes -= bytes;
      });
  });
}
