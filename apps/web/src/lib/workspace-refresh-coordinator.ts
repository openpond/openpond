import type { ClientConnection } from "../api";

export type WorkspaceRefreshHandle<T> = {
  key: string;
  promise: Promise<T>;
  release: () => void;
  shared: boolean;
};

type InFlightRequest<T> = {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<T>;
};

export function createWorkspaceRefreshCoordinator() {
  const inFlight = new Map<string, InFlightRequest<unknown>>();

  function request<T>(
    key: string,
    loader: (signal: AbortSignal) => Promise<T>,
  ): WorkspaceRefreshHandle<T> {
    const existing = inFlight.get(key) as InFlightRequest<T> | undefined;
    if (existing) {
      existing.consumers += 1;
      return handleForRequest(key, existing, true);
    }

    const controller = new AbortController();
    const entry: InFlightRequest<T> = {
      controller,
      consumers: 1,
      settled: false,
      promise: Promise.resolve()
        .then(() => loader(controller.signal))
        .finally(() => {
          entry.settled = true;
          if (inFlight.get(key) === entry) inFlight.delete(key);
        }),
    };
    inFlight.set(key, entry as InFlightRequest<unknown>);
    return handleForRequest(key, entry, false);
  }

  function handleForRequest<T>(
    key: string,
    entry: InFlightRequest<T>,
    shared: boolean,
  ): WorkspaceRefreshHandle<T> {
    let released = false;
    return {
      key,
      promise: entry.promise,
      shared,
      release: () => {
        if (released) return;
        released = true;
        entry.consumers = Math.max(0, entry.consumers - 1);
        if (entry.consumers === 0 && !entry.settled) {
          entry.controller.abort();
        }
      },
    };
  }

  function cancelAll(): void {
    for (const entry of inFlight.values()) {
      entry.consumers = 0;
      if (!entry.settled) entry.controller.abort();
    }
  }

  return {
    request,
    cancelAll,
    inFlightCount: () => inFlight.size,
  };
}

export type WorkspaceRefreshCoordinator = ReturnType<typeof createWorkspaceRefreshCoordinator>;

export function workspaceStatusRefreshKey(
  connection: ClientConnection,
  appId: string,
  ensure: boolean,
): string {
  return `workspace-status:${connection.serverUrl}:${appId}:${ensure ? "ensure" : "read"}`;
}

export function workspaceDiffRefreshKey(connection: ClientConnection, appId: string): string {
  return `workspace-diff:${connection.serverUrl}:${appId}`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
