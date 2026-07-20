import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  Approval,
  BootstrapPayload,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  RuntimeEvent,
  Session,
  SidebarAppPreferences,
} from "@openpond/contracts";
import { api, resolveConnection, type ClientConnection, type PreferencesPayload } from "../api";
import { normalizePreferences, parseProjectSelection, projectSelectionKey } from "../lib/app-models";
import { latestReadyLocalCreateImproveProfileRefreshKey } from "../lib/create-pipeline-profile-refresh";
import {
  codexPreferencesWithLocalOverrides,
  storedCodexPreferenceSyncPatch,
} from "../lib/codex-preferences";
import {
  openPondCommandAccessPreferencesWithLocalOverride,
  storedOpenPondCommandAccessPreferenceSyncPatch,
} from "../lib/openpond-command-access-preferences";
import {
  normalizeOpenPondOrganization,
  resolveDefaultOpenPondOrganization,
} from "../lib/cloud-project-utils";
import { isSameConnection } from "../lib/layout";
import { isConnectionErrorMessage } from "../lib/error-messages";
import type { OpenPondOrganization } from "../lib/organization-types";
import {
  openPondOrganizationCacheKey,
  preloadOpenPondOrganizations,
} from "../lib/openpond-organization-memory";
import { preloadSandboxAgents } from "../lib/sandbox-agent-memory";
import {
  mergeSidebarAppPreferencesPreservingRecentLocal,
  recordSidebarAppPreferenceChanges,
  type SidebarAppPreferenceChangeTimes,
} from "../lib/sidebar-preference-state";
import {
  mergeBootstrapSessionListPreservingLocalState,
  mergeSessionListPreservingLocalSidebarState,
  recordSessionSidebarStateChanges,
  shouldPreserveMissingBootstrapSession,
  type SessionSidebarStateChangeTimes,
} from "../lib/session-state";
import {
  latestRuntimeEventSequence,
  limitRuntimeEventList,
  mergeBootstrapRuntimeEvents,
} from "../lib/runtime-event-lists";
import {
  appStartupState,
  type AppStartupStageId,
} from "../startup/app-startup";
import { useRuntimeEvents } from "./useAppEffects";

type SetState<T> = Dispatch<SetStateAction<T>>;

const STARTUP_SPLASH_FAST_MINIMUM_MS = 650;
const STARTUP_SPLASH_SLOW_THRESHOLD_MS = 1200;
const ORGANIZATION_REFRESH_INTERVAL_MS = 60_000;

export function useAppBootstrap(params: {
  setDraftModel: SetState<string>;
  setDraftProvider: SetState<ChatProvider>;
  setCodexPermissionMode: SetState<CodexPermissionMode>;
  setCodexReasoningEffort: SetState<CodexReasoningEffort>;
  setOpenPondCommandAccessMode: SetState<OpenPondCommandAccessMode>;
  setError: SetState<string | null>;
  setSelectedAppId: SetState<string | null>;
  setSelectedProjectId: SetState<string | null>;
  setSelectedSessionId: SetState<string | null>;
}) {
  const {
    setDraftModel,
    setDraftProvider,
    setCodexPermissionMode,
    setCodexReasoningEffort,
    setOpenPondCommandAccessMode,
    setError,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
  } = params;
  const [connection, setConnection] = useState<ClientConnection | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [runtimeEventStreamStart, setRuntimeEventStreamStart] = useState<{
    afterSequence: number;
    serverId: string;
  } | null>(null);
  const [sessions, setSessionsState] = useState<Session[]>([]);
  const [codexHistorySessions, setCodexHistorySessionsState] = useState<Session[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [appPreferences, setAppPreferencesState] = useState<SidebarAppPreferences>({});
  const [startupStage, setStartupStage] = useState<AppStartupStageId>("connecting");
  const organizationRefreshAccountKey = openPondOrganizationCacheKey(bootstrap?.account);
  const appPreferenceChangeTimesRef = useRef<SidebarAppPreferenceChangeTimes>({});
  const sessionSidebarChangeTimesRef = useRef<SessionSidebarStateChangeTimes>({});
  const codexHistorySessionSidebarChangeTimesRef = useRef<SessionSidebarStateChangeTimes>({});
  const sessionsRef = useRef<Session[]>([]);
  const codexHistorySessionsRef = useRef<Session[]>([]);
  const bootstrapServerIdRef = useRef<string | null>(null);
  const codexPreferenceSyncKeyRef = useRef<string | null>(null);
  const openPondCommandAccessPreferenceSyncKeyRef = useRef<string | null>(null);
  const defaultTeamSyncKeyRef = useRef<string | null>(null);
  const latestDefaultTeamIdRef = useRef("");
  const startupReadyRef = useRef(false);
  const startupStartedAtRef = useRef(Date.now());
  const startupCompleteTimerRef = useRef<number | null>(null);
  const profileRefreshCreatePipelineKeyRef = useRef<string | null>(null);

  const setBlockingStartupStage = useCallback((stage: Exclude<AppStartupStageId, "ready">) => {
    if (!startupReadyRef.current) setStartupStage(stage);
  }, []);

  const setAppPreferences = useCallback<Dispatch<SetStateAction<SidebarAppPreferences>>>((action) => {
    setAppPreferencesState((current) => {
      const next = typeof action === "function" ? action(current) : action;
      recordSidebarAppPreferenceChanges(appPreferenceChangeTimesRef.current, current, next);
      return next;
    });
  }, []);

  const setSessions = useCallback<Dispatch<SetStateAction<Session[]>>>((action) => {
    setSessionsState((current) => {
      const next = typeof action === "function" ? action(current) : action;
      recordSessionSidebarStateChanges(sessionSidebarChangeTimesRef.current, current, next);
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const setCodexHistorySessions = useCallback<Dispatch<SetStateAction<Session[]>>>((action) => {
    setCodexHistorySessionsState((current) => {
      const next = typeof action === "function" ? action(current) : action;
      recordSessionSidebarStateChanges(codexHistorySessionSidebarChangeTimesRef.current, current, next);
      codexHistorySessionsRef.current = next;
      return next;
    });
  }, []);

  const completeStartup = useCallback(() => {
    if (startupReadyRef.current || startupCompleteTimerRef.current !== null) return;
    const finishStartup = () => {
      startupCompleteTimerRef.current = null;
      if (startupReadyRef.current) return;
      startupReadyRef.current = true;
      setStartupStage("ready");
    };
    const elapsed = Date.now() - startupStartedAtRef.current;
    const remaining = startupSplashRemainingMs(elapsed);
    if (remaining === 0) {
      finishStartup();
      return;
    }
    startupCompleteTimerRef.current = window.setTimeout(finishStartup, remaining);
  }, []);

  useEffect(() => {
    return () => {
      if (startupCompleteTimerRef.current !== null) {
        window.clearTimeout(startupCompleteTimerRef.current);
      }
    };
  }, []);

  const applyBootstrapPayload = useCallback(
    (payload: BootstrapPayload) => {
      const previousServerId = bootstrapServerIdRef.current;
      const sameServer = !previousServerId || previousServerId === payload.server.id;
      bootstrapServerIdRef.current = payload.server.id;
      setRuntimeEventStreamStart((current) =>
        current?.serverId === payload.server.id
          ? current
          : {
              afterSequence:
                payload.eventWindow?.latestSequence
                ?? latestRuntimeEventSequence(payload.events)
                ?? 0,
              serverId: payload.server.id,
            },
      );
      latestDefaultTeamIdRef.current = payload.preferences.defaultTeamId?.trim() ?? "";
      setBootstrap(payload);
      setEvents((current) => sameServer
        ? mergeBootstrapRuntimeEvents(payload.events, current)
        : limitRuntimeEventList(payload.events));
      setSessionsState((current) => {
        const next = sameServer
          ? mergeBootstrapSessionListPreservingLocalState(
              current,
              payload.sessions,
              sessionSidebarChangeTimesRef.current,
            )
          : mergeSessionListPreservingLocalSidebarState(
              current,
              payload.sessions,
              sessionSidebarChangeTimesRef.current,
            );
        sessionsRef.current = next;
        return next;
      });
      setCodexHistorySessionsState((current) => {
        const next = sameServer
          ? mergeBootstrapSessionListPreservingLocalState(
              current,
              payload.codexHistorySessions ?? [],
              codexHistorySessionSidebarChangeTimesRef.current,
            )
          : mergeSessionListPreservingLocalSidebarState(
              current,
              payload.codexHistorySessions ?? [],
              codexHistorySessionSidebarChangeTimesRef.current,
            );
        codexHistorySessionsRef.current = next;
        return next;
      });
      setApprovals(payload.approvals);
      setAppPreferencesState((current) =>
        mergeSidebarAppPreferencesPreservingRecentLocal(
          current,
          payload.sidebarAppPreferences,
          appPreferenceChangeTimesRef.current,
        ),
      );
      setSelectedAppId((current) => (current && payload.apps.some((app) => app.id === current) ? current : null));
      setSelectedProjectId((current) => {
        if (!current) return null;
        const selection = parseProjectSelection(current);
        if (selection?.kind === "local" && payload.localProjects.some((project) => project.id === selection.id)) {
          return projectSelectionKey("local", selection.id);
        }
        if (selection?.kind === "cloud" && (payload.cloudProjects ?? []).some((project) => project.id === selection.id)) {
          return projectSelectionKey("cloud", selection.id);
        }
        if (payload.localProjects.some((project) => project.id === current)) return projectSelectionKey("local", current);
        if ((payload.cloudProjects ?? []).some((project) => project.id === current)) return projectSelectionKey("cloud", current);
        return null;
      });
      setSelectedSessionId((current) => {
        if (!current) return null;
        const incomingSessions = [...payload.sessions, ...(payload.codexHistorySessions ?? [])];
        if (incomingSessions.some((session) => session.id === current && !session.archived)) return current;
        if (!sameServer) return null;
        const existingSession =
          sessionsRef.current.find((session) => session.id === current) ??
          codexHistorySessionsRef.current.find((session) => session.id === current) ??
          null;
        return existingSession &&
          !existingSession.archived &&
          shouldPreserveMissingBootstrapSession(existingSession, incomingSessions)
          ? current
          : null;
      });
    },
    [setSelectedAppId, setSelectedProjectId, setSelectedSessionId]
  );

  const applyPreferencesPayload = useCallback((payload: PreferencesPayload) => {
    latestDefaultTeamIdRef.current = payload.preferences.defaultTeamId?.trim() ?? "";
    setBootstrap((current) => (current ? { ...current, preferences: payload.preferences } : current));
  }, []);

  useEffect(() => {
    const preferences = normalizePreferences(bootstrap?.preferences);
    setDraftProvider(preferences.defaultChatProvider);
    setDraftModel(preferences.defaultChatModel);
  }, [
    bootstrap?.preferences.defaultChatProvider,
    bootstrap?.preferences.defaultChatModel,
    setDraftModel,
    setDraftProvider,
  ]);

  useEffect(() => {
    setCodexPermissionMode(codexPreferencesWithLocalOverrides(bootstrap?.preferences).codexPermissionMode);
  }, [
    bootstrap?.preferences.codexPermissionMode,
    setCodexPermissionMode,
  ]);

  useEffect(() => {
    setCodexReasoningEffort(codexPreferencesWithLocalOverrides(bootstrap?.preferences).codexReasoningEffort);
  }, [
    bootstrap?.preferences.codexReasoningEffort,
    setCodexReasoningEffort,
  ]);

  useEffect(() => {
    setOpenPondCommandAccessMode(
      openPondCommandAccessPreferencesWithLocalOverride(bootstrap?.preferences).openPondCommandAccessMode,
    );
  }, [
    bootstrap?.preferences.openPondCommandAccessMode,
    setOpenPondCommandAccessMode,
  ]);

  useEffect(() => {
    if (!connection || !bootstrap) return;
    const patch = storedCodexPreferenceSyncPatch(bootstrap.preferences);
    const syncKey = JSON.stringify(patch);
    if (syncKey === "{}") {
      codexPreferenceSyncKeyRef.current = null;
      return;
    }
    if (codexPreferenceSyncKeyRef.current === syncKey) return;
    codexPreferenceSyncKeyRef.current = syncKey;
    void api
      .savePreferences(connection, patch)
      .then(applyPreferencesPayload)
      .catch((syncError) => {
        codexPreferenceSyncKeyRef.current = null;
        setError(syncError instanceof Error ? syncError.message : String(syncError));
      });
  }, [
    applyPreferencesPayload,
    bootstrap,
    bootstrap?.preferences.codexPermissionMode,
    bootstrap?.preferences.codexReasoningEffort,
    connection,
    setError,
  ]);

  useEffect(() => {
    if (!connection || !bootstrap) return;
    const patch = storedOpenPondCommandAccessPreferenceSyncPatch(bootstrap.preferences);
    const syncKey = JSON.stringify(patch);
    if (syncKey === "{}") {
      openPondCommandAccessPreferenceSyncKeyRef.current = null;
      return;
    }
    if (openPondCommandAccessPreferenceSyncKeyRef.current === syncKey) return;
    openPondCommandAccessPreferenceSyncKeyRef.current = syncKey;
    void api
      .savePreferences(connection, patch)
      .then(applyPreferencesPayload)
      .catch((syncError) => {
        openPondCommandAccessPreferenceSyncKeyRef.current = null;
        setError(syncError instanceof Error ? syncError.message : String(syncError));
      });
  }, [
    applyPreferencesPayload,
    bootstrap,
    bootstrap?.preferences.openPondCommandAccessMode,
    connection,
    setError,
  ]);

  useEffect(() => {
    if (!connection || !bootstrap) {
      defaultTeamSyncKeyRef.current = null;
      return;
    }

    if (bootstrap.account.state !== "signed_in") {
      defaultTeamSyncKeyRef.current = null;
      completeStartup();
      return;
    }

    const accountKey = openPondOrganizationCacheKey(bootstrap.account);
    if (!accountKey) {
      defaultTeamSyncKeyRef.current = null;
      completeStartup();
      return;
    }
    completeStartup();
    setBlockingStartupStage("team");

    const currentDefaultTeamId = bootstrap.preferences.defaultTeamId?.trim() ?? "";
    const syncKey = defaultTeamPreferenceSyncKey(
      accountKey,
      currentDefaultTeamId,
      bootstrap.accountMeta.asOf ?? "initial",
    );
    if (defaultTeamSyncKeyRef.current === syncKey) return;
    defaultTeamSyncKeyRef.current = syncKey;

    let cancelled = false;
    const preloadTeamAgents = (teamId: string) =>
      preloadSandboxAgents({
        teamId,
        accountKey,
        fetchAgents: async (nextTeamId) => {
          const agentsPayload = await api.listSandboxAgents(connection, { teamId: nextTeamId });
          return agentsPayload.agents;
        },
      }).catch(() => {
        if (!cancelled && defaultTeamSyncKeyRef.current === syncKey) {
          defaultTeamSyncKeyRef.current = null;
        }
      });

    void preloadOpenPondOrganizations({
      accountKey,
      force: true,
      fetchOrganizations: () => fetchActiveOpenPondOrganizations(connection),
    })
      .then(async (activeOrganizations) => {
        if (cancelled) return;
        if (activeOrganizations.length === 0) {
          completeStartup();
          return;
        }

        const currentDefaultStillActive =
          Boolean(currentDefaultTeamId) &&
          activeOrganizations.some((organization) => organization.teamId === currentDefaultTeamId);
        if (currentDefaultStillActive) {
          await preloadTeamAgents(currentDefaultTeamId);
          completeStartup();
          return;
        }

        const fallbackTeamId = resolveDefaultOpenPondOrganization(activeOrganizations)?.teamId;
        if (!fallbackTeamId) {
          completeStartup();
          return;
        }
        const latestDefaultTeamId = latestDefaultTeamIdRef.current;
        if (latestDefaultTeamId && latestDefaultTeamId !== currentDefaultTeamId) {
          completeStartup();
          return;
        }
        const preloadAgentsPromise = preloadTeamAgents(fallbackTeamId);
        defaultTeamSyncKeyRef.current = defaultTeamPreferenceSyncKey(
          accountKey,
          fallbackTeamId,
          bootstrap.accountMeta.asOf ?? "initial",
        );
        const updatedPayload = await api.savePreferences(connection, { defaultTeamId: fallbackTeamId });
        await preloadAgentsPromise;
        const latestDefaultTeamIdAfterSave = latestDefaultTeamIdRef.current;
        if (cancelled) {
          if (latestDefaultTeamIdAfterSave && latestDefaultTeamIdAfterSave !== fallbackTeamId) {
            void api
              .savePreferences(connection, { defaultTeamId: latestDefaultTeamIdAfterSave })
              .then(applyPreferencesPayload)
              .catch((defaultTeamError) => {
                setError(defaultTeamError instanceof Error ? defaultTeamError.message : String(defaultTeamError));
              });
          }
          return;
        }
        if (latestDefaultTeamIdAfterSave && latestDefaultTeamIdAfterSave !== fallbackTeamId) {
          applyPreferencesPayload(
            await api.savePreferences(connection, { defaultTeamId: latestDefaultTeamIdAfterSave }),
          );
          completeStartup();
          return;
        }
        if (!cancelled) {
          applyPreferencesPayload(updatedPayload);
          completeStartup();
        }
      })
      .catch((defaultTeamError) => {
        if (cancelled) return;
        defaultTeamSyncKeyRef.current = null;
        setError(defaultTeamError instanceof Error ? defaultTeamError.message : String(defaultTeamError));
        completeStartup();
      });
    return () => {
      cancelled = true;
    };
  }, [
    applyBootstrapPayload,
    applyPreferencesPayload,
    bootstrap?.account,
    bootstrap?.accountMeta.asOf,
    bootstrap?.preferences.defaultTeamId,
    completeStartup,
    connection,
    setBlockingStartupStage,
    setError,
  ]);

  useEffect(() => {
    if (!connection || !organizationRefreshAccountKey) return;
    let refreshing = false;
    const refreshOrganizations = () => {
      if (refreshing) return;
      refreshing = true;
      void preloadOpenPondOrganizations({
        accountKey: organizationRefreshAccountKey,
        force: true,
        fetchOrganizations: () => fetchActiveOpenPondOrganizations(connection),
      })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshOrganizations();
    };
    const intervalId = window.setInterval(
      refreshOrganizations,
      ORGANIZATION_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshOrganizations);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOrganizations);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [connection, organizationRefreshAccountKey]);

  const load = useCallback(async () => {
    setBlockingStartupStage("connecting");
    setRuntimeEventStreamStart(null);
    const nextConnection = await resolveConnection();
    setConnection((current) => (isSameConnection(current, nextConnection) ? current : nextConnection));
    setBlockingStartupStage("account");
    const payload = await api.bootstrap(nextConnection);
    applyBootstrapPayload(payload);
    completeStartup();
    setError((current) =>
      current && (isConnectionErrorMessage(current) || current === "Event stream disconnected")
        ? null
        : current
    );
  }, [applyBootstrapPayload, completeStartup, setBlockingStartupStage, setError]);

  useEffect(() => {
    let cancelled = false;
    let retryId: number | null = null;
    const run = async (attempt: number) => {
      try {
        await load();
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        const delay = Math.min(5000, 750 + attempt * 750);
        retryId = window.setTimeout(() => void run(attempt + 1), delay);
      }
    };
    void run(0);
    return () => {
      cancelled = true;
      if (retryId !== null) window.clearTimeout(retryId);
    };
  }, [load, setError]);

  const recoverConnection = useCallback(() => {
    void load().catch(() => undefined);
  }, [load]);

  useRuntimeEvents({
    afterSequence: runtimeEventStreamStart?.afterSequence ?? null,
    connection,
    setEvents,
    setApprovals,
    setSessions,
    setError,
    onDisconnected: recoverConnection,
  });

  useEffect(() => {
    if (!connection || !bootstrap) {
      profileRefreshCreatePipelineKeyRef.current = null;
      return;
    }
    const refreshKey = latestReadyLocalCreateImproveProfileRefreshKey(events);
    if (!refreshKey || profileRefreshCreatePipelineKeyRef.current === refreshKey) return;
    profileRefreshCreatePipelineKeyRef.current = refreshKey;
    void api
      .profileCurrent(connection)
      .then((profile) => {
        setBootstrap((current) => (current ? { ...current, profile } : current));
      })
      .catch((refreshError) => {
        profileRefreshCreatePipelineKeyRef.current = null;
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      });
  }, [bootstrap, connection, events, setError]);

  const refreshOpenPondAccount = useCallback(() => {
    if (!connection) return;
    void api
      .refreshOpenPondAccount(connection)
      .then(({ account, accountMeta }) => {
        setBootstrap((current) => (current ? { ...current, account, accountMeta } : current));
      })
      .catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError)));
  }, [connection, setError]);

  return {
    appPreferences,
    applyBootstrapPayload,
    approvals,
    bootstrap,
    codexHistorySessions,
    connection,
    events,
    refreshOpenPondAccount,
    sessions,
    startup: appStartupState(startupStage),
    setAppPreferences,
    setBootstrap,
    setCodexHistorySessions,
    setEvents,
    setSessions,
  };
}

async function fetchActiveOpenPondOrganizations(
  connection: ClientConnection,
): Promise<OpenPondOrganization[]> {
  const payload = await api.organizations(connection);
  return payload.organizations
    .map(normalizeOpenPondOrganization)
    .filter((organization): organization is OpenPondOrganization => Boolean(organization))
    .filter((organization) => organization.status === "active");
}

export function startupSplashRemainingMs(elapsedMs: number): number {
  if (elapsedMs >= STARTUP_SPLASH_SLOW_THRESHOLD_MS) return 0;
  return Math.max(0, STARTUP_SPLASH_FAST_MINIMUM_MS - elapsedMs);
}

function defaultTeamPreferenceSyncKey(
  accountKey: string,
  defaultTeamId: string,
  accountRefreshKey: string,
): string {
  return `${accountKey}::${defaultTeamId || "none"}::${accountRefreshKey}`;
}
