import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WorkspaceDiffSummary, WorkspaceState } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { AppView } from "../lib/app-models";
import {
  createWorkspaceRefreshCoordinator,
  isAbortError,
  workspaceDiffRefreshKey,
  workspaceStatusRefreshKey,
} from "../lib/workspace-refresh-coordinator";

type UseWorkspaceControllerInput = {
  connection: ClientConnection | null;
  activeWorkspaceAppId: string | null | undefined;
  view: AppView;
  shouldLoadWorkspaceDiff: boolean;
  sidebarWorkspaceAppIds: string[];
  setError: Dispatch<SetStateAction<string | null>>;
};

type RefreshWorkspaceDiffOptions = {
  silent?: boolean;
};

export function useWorkspaceController({
  connection,
  activeWorkspaceAppId,
  view,
  shouldLoadWorkspaceDiff,
  sidebarWorkspaceAppIds,
  setError,
}: UseWorkspaceControllerInput) {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [workspaceStates, setWorkspaceStates] = useState<Record<string, WorkspaceState>>({});
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiffSummary | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const requestedWorkspaceStatusAppIds = useRef<Set<string>>(new Set());
  const refreshCoordinatorRef = useRef(createWorkspaceRefreshCoordinator());

  const visibleWorkspaceState =
    activeWorkspaceAppId
      ? (workspaceStates[activeWorkspaceAppId] ?? (workspaceState?.appId === activeWorkspaceAppId ? workspaceState : null))
      : null;
  const visibleWorkspaceDiff = workspaceDiff?.appId === activeWorkspaceAppId ? workspaceDiff : null;

  const rememberWorkspaceState = useCallback((state: WorkspaceState) => {
    requestedWorkspaceStatusAppIds.current.add(state.appId);
    setWorkspaceState(state);
    setWorkspaceStates((current) => ({
      ...current,
      [state.appId]: state,
    }));
  }, []);

  const refreshWorkspace = useCallback(
    async (appId: string | null | undefined, ensure = false) => {
      if (!connection || !appId) {
        setWorkspaceState(null);
        return null;
      }
      setWorkspaceBusy(true);
      const request = refreshCoordinatorRef.current.request(
        workspaceStatusRefreshKey(connection, appId, ensure),
        (signal) => api.workspaceStatus(connection, appId, ensure, { signal }),
      );
      try {
        const state = await request.promise;
        rememberWorkspaceState(state);
        if (ensure && state.error) {
          setError(`Workspace sync failed: ${state.error}`);
        } else if (ensure) {
          setError(null);
        }
        return state;
      } catch (workspaceError) {
        if (isAbortError(workspaceError)) return null;
        setWorkspaceState(null);
        setError(workspaceError instanceof Error ? workspaceError.message : String(workspaceError));
        return null;
      } finally {
        request.release();
        setWorkspaceBusy(false);
      }
    },
    [connection, rememberWorkspaceState, setError]
  );

  const refreshWorkspaceDiff = useCallback(
    async (
      appId: string | null | undefined = activeWorkspaceAppId,
      options: RefreshWorkspaceDiffOptions = {},
    ) => {
      if (!connection || !appId) {
        setWorkspaceDiff(null);
        return null;
      }
      if (!options.silent) setDiffBusy(true);
      const request = refreshCoordinatorRef.current.request(
        workspaceDiffRefreshKey(connection, appId),
        (signal) => api.workspaceDiff(connection, appId, { signal }),
      );
      try {
        const diff = await request.promise;
        setWorkspaceDiff(diff);
        return diff;
      } catch (diffError) {
        if (isAbortError(diffError)) return null;
        setWorkspaceDiff(null);
        setError(diffError instanceof Error ? diffError.message : String(diffError));
        return null;
      } finally {
        request.release();
        if (!options.silent) setDiffBusy(false);
      }
    },
    [activeWorkspaceAppId, connection, setError]
  );

  useEffect(() => {
    if (!connection || !activeWorkspaceAppId || view !== "chat") {
      setWorkspaceState(null);
      setWorkspaceDiff(null);
      setWorkspaceBusy(false);
      return;
    }
    let cancelled = false;
    const statusRequest = refreshCoordinatorRef.current.request(
      workspaceStatusRefreshKey(connection, activeWorkspaceAppId, false),
      (signal) => api.workspaceStatus(connection, activeWorkspaceAppId, false, { signal }),
    );
    setWorkspaceBusy(true);
    statusRequest.promise
      .then((state) => {
        if (cancelled) return;
        rememberWorkspaceState(state);
        if (!state.initialized) setWorkspaceDiff(null);
      })
      .catch((workspaceError) => {
        if (isAbortError(workspaceError)) return;
        if (cancelled) return;
        setWorkspaceState(null);
        setError(workspaceError instanceof Error ? workspaceError.message : String(workspaceError));
      })
      .finally(() => {
        statusRequest.release();
        if (!cancelled) setWorkspaceBusy(false);
      });
    return () => {
      cancelled = true;
      statusRequest.release();
    };
  }, [
    activeWorkspaceAppId,
    connection,
    rememberWorkspaceState,
    setError,
    view,
  ]);

  useEffect(() => {
    if (!connection || !activeWorkspaceAppId || !visibleWorkspaceState?.initialized || view !== "chat") {
      setWorkspaceDiff(null);
      return;
    }
    if (!shouldLoadWorkspaceDiff) {
      setWorkspaceDiff((current) => (current?.appId === activeWorkspaceAppId ? null : current));
      return;
    }
    void refreshWorkspaceDiff(activeWorkspaceAppId);
  }, [
    activeWorkspaceAppId,
    connection,
    refreshWorkspaceDiff,
    shouldLoadWorkspaceDiff,
    view,
    visibleWorkspaceState?.dirty,
    visibleWorkspaceState?.initialized,
  ]);

  useEffect(() => {
    if (!connection || sidebarWorkspaceAppIds.length === 0) return undefined;
    const pendingIds = sidebarWorkspaceAppIds.filter((appId) => !requestedWorkspaceStatusAppIds.current.has(appId));
    if (pendingIds.length === 0) return undefined;
    pendingIds.forEach((appId) => requestedWorkspaceStatusAppIds.current.add(appId));
    let cancelled = false;
    const requests = pendingIds.map((appId) =>
      refreshCoordinatorRef.current.request(
        workspaceStatusRefreshKey(connection, appId, false),
        (signal) => api.workspaceStatus(connection, appId, false, { signal }),
      )
    );
    void Promise.all(
      requests.map((request) =>
        request.promise
          .then((state) => state)
          .catch((error) => (isAbortError(error) ? null : null))
          .finally(() => request.release())
      )
    ).then((results) => {
      if (cancelled) return;
      for (const state of results) {
        if (state) rememberWorkspaceState(state);
      }
    });
    return () => {
      cancelled = true;
      requests.forEach((request) => request.release());
    };
  }, [connection, rememberWorkspaceState, sidebarWorkspaceAppIds]);

  useEffect(() => () => refreshCoordinatorRef.current.cancelAll(), []);

  return {
    workspaceState,
    workspaceStates,
    workspaceDiff,
    workspaceBusy,
    diffBusy,
    visibleWorkspaceState,
    visibleWorkspaceDiff,
    rememberWorkspaceState,
    refreshWorkspace,
    refreshWorkspaceDiff,
    setWorkspaceBusy,
  };
}
