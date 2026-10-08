import { randomUUID } from "node:crypto";
import {
  REMOTE_DEVICE_LIMITS,
  RemoteCatalogAckSchema,
  RemoteCatalogPublicationSchema,
  remoteDeviceCanonicalContent,
  type RemoteCatalogPublication,
  type RemoteStarter,
  type RemoteTask,
} from "@openpond/contracts";

type Directory = {
  tasks: Map<string, RemoteTask>;
  starters: Map<string, RemoteStarter>;
};
type Pending = {
  mode: "snapshot" | "patch";
  snapshotId: string;
  revision: number;
  pageIndex: number;
  final: boolean;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

/** Only a committed hosted ACK advances the next patch's base and source directory. */
export function createCatalogPublication(
  send: (page: RemoteCatalogPublication) => void,
) {
  let acknowledged: Directory | null = null;
  let revision = 0;
  let pending: Pending | null = null;
  let publishing = false;
  let incarnation = 0;
  const cancel = (error: Error) => {
    if (!pending) return;
    const previous = pending;
    pending = null;
    clearTimeout(previous.timeout);
    previous.reject(error);
  };
  return {
    reset(committedRevision = 0) {
      incarnation++;
      cancel(new Error("remote_catalog_connection_lost"));
      acknowledged = null;
      revision = Math.max(revision, committedRevision);
    },
    resync(committedRevision: number) {
      incarnation++;
      acknowledged = null;
      revision = Math.max(revision, committedRevision);
      cancel(new Error("remote_catalog_resync_required"));
    },
    acknowledge(value: unknown) {
      const ack = RemoteCatalogAckSchema.parse(value);
      if (
        !pending ||
        ack.snapshotId !== pending.snapshotId ||
        ack.revision !== pending.revision ||
        ack.mode !== pending.mode ||
        ack.pageIndex !== pending.pageIndex
      )
        return;
      if (
        ack.committed !== pending.final ||
        (pending.final && ack.catalogRevision !== pending.revision)
      )
        throw new Error("remote_catalog_ack_invalid");
      const previous = pending;
      pending = null;
      clearTimeout(previous.timeout);
      previous.resolve();
    },
    async publish(tasks: RemoteTask[], starters: RemoteStarter[]) {
      if (publishing) throw new Error("remote_catalog_publication_in_progress");
      const next: Directory = {
        tasks: new Map(tasks.map((task) => [task.id, task])),
        starters: new Map(starters.map((starter) => [starter.id, starter])),
      };
      const changed = <T>(current: Map<string, T>, previous?: Map<string, T>) =>
        [...current.values()].filter((value) => {
          const id = (value as { id: string }).id;
          return (
            !previous?.has(id) ||
            remoteDeviceCanonicalContent(previous.get(id)) !==
              remoteDeviceCanonicalContent(value)
          );
        });
      const removed = <T>(
        previous: Map<string, T> | undefined,
        current: Map<string, T>,
      ) => [...(previous?.keys() ?? [])].filter((id) => !current.has(id));
      const changes = {
        tasks: changed(next.tasks, acknowledged?.tasks),
        starters: changed(next.starters, acknowledged?.starters),
        removedIds: removed(acknowledged?.tasks, next.tasks),
        removedStarterIds: removed(acknowledged?.starters, next.starters),
      };
      if (
        acknowledged &&
        Object.values(changes).every((items) => items.length === 0)
      )
        return false;
      const mode = acknowledged ? ("patch" as const) : ("snapshot" as const);
      const baseRevision = revision;
      const nextRevision = Math.max(Date.now(), revision + 1);
      const snapshotId = randomUUID();
      const common = {
        mode,
        revision: nextRevision,
        snapshotId,
        ...(mode === "patch" ? { baseRevision } : {}),
      };
      const bodies: (typeof changes)[] = [
        { tasks: [], starters: [], removedIds: [], removedStarterIds: [] },
      ];
      for (const key of [
        "tasks",
        "starters",
        "removedIds",
        "removedStarterIds",
      ] as const) {
        for (const value of changes[key]) {
          let page = bodies.at(-1)!;
          const projected = { ...page, [key]: [...page[key], value] };
          if (
            page[key].length >= 100 ||
            Buffer.byteLength(JSON.stringify(projected)) >
              REMOTE_DEVICE_LIMITS.frameBytes - 4_096
          ) {
            page = {
              tasks: [],
              starters: [],
              removedIds: [],
              removedStarterIds: [],
            };
            bodies.push(page);
          }
          // The key discriminates the item type; retain the typed wire schema below.
          (page[key] as (RemoteTask | RemoteStarter | string)[]).push(value);
        }
      }
      if (
        bodies.length > 100 ||
        Buffer.byteLength(JSON.stringify(bodies)) > 8_388_608
      )
        throw new Error("remote_catalog_publication_limit");
      const pages = bodies.map((body, pageIndex) =>
        RemoteCatalogPublicationSchema.parse({
          ...common,
          ...body,
          pageIndex,
          pageCount: bodies.length,
          complete: pageIndex === bodies.length - 1,
        }),
      );
      const startedIncarnation = incarnation;
      publishing = true;
      const publicationDeadline = Date.now() + 45_000;
      try {
        for (const page of pages) {
          if (startedIncarnation !== incarnation)
            throw new Error("remote_catalog_connection_lost");
          const remaining = publicationDeadline - Date.now();
          if (remaining <= 0)
            throw new Error("remote_catalog_publication_timeout");
          const received = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => cancel(new Error("remote_catalog_ack_timeout")),
              Math.min(5_000, remaining),
            );
            timeout.unref();
            pending = {
              mode,
              snapshotId,
              revision: nextRevision,
              pageIndex: page.pageIndex,
              final: page.complete,
              resolve,
              reject,
              timeout,
            };
          });
          try {
            send(page);
            await received;
          } catch (error) {
            cancel(
              error instanceof Error
                ? error
                : new Error("remote_catalog_failed"),
            );
            await received.catch(() => undefined);
            throw error;
          }
        }
        if (startedIncarnation !== incarnation)
          throw new Error("remote_catalog_connection_lost");
        revision = nextRevision;
        acknowledged = next;
        return true;
      } finally {
        publishing = false;
      }
    },
  };
}
