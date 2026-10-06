import { useCallback, useEffect, useRef, useState } from "react";
import type { BootstrapPayload, ProviderSettings } from "@openpond/contracts";
import { type ClientConnection } from "../../api";
import { apiFetch } from "../../api/api-client";
import { normalizePreferences } from "../../lib/app-models";
import { ProviderDetailsDialog } from "../settings/ProviderSettingsSection";
import { useProviderSettings } from "../settings/useProviderSettings";
import { RefreshCw, X, Plus } from "../icons";
import { AGENT_SOURCES, type AgentSource } from "./agent-connections";
import { AgentConnectionCard } from "./AgentConnectionCard";
import { useNativeAgentConnections } from "./useNativeAgentConnections";
import { useAgentProjects } from "./useAgentProjects";
import { useAgentInventory } from "./useAgentInventory";
import { useAgentDialogFocus } from "./useAgentDialogFocus";
import type { ReactNode } from "react";
import { AgentConversationSetup } from "./AgentConversationSetup";
import "../../styles/apps/connected-agents.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";
import "../../styles/settings/provider-connections.css";

export function ConnectedAgentsView({
  connection,
  payload,
  onPayload,
  onToast,
}: {
  connection: ClientConnection | null;
  payload: BootstrapPayload | null;
  onPayload(payload: BootstrapPayload): void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const { inventory, error, loading, refresh } = useAgentInventory(connection);
  const [selected, setSelected] = useState<AgentSource | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [providerRevision, setProviderRevision] = useState(0);
  const visibilityKey = `openpond-agent-cards:${JSON.stringify(payload?.account.activeProfile ?? null)}`;
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(visibilityKey) ?? "null",
      );
      return Array.isArray(value)
        ? value.filter(
            (id): id is string =>
              typeof id === "string" &&
              AGENT_SOURCES.some((item) => item.id === id),
          )
        : ["oh_my_pi"];
    } catch {
      return ["oh_my_pi"];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(visibilityKey, JSON.stringify(hidden));
    } catch {
      /* Optional presentation preference. */
    }
  }, [visibilityKey, hidden]);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [moreOpen]);
  const latest = useRef({ payload, onPayload });
  latest.current = { payload, onPayload };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const account = payload?.account ?? null;
  const teamId =
    payload?.preferences.defaultTeamId ??
    account?.accounts.find((item) => item.isActive)?.apiKeyAccess?.teamId ??
    null;
  const onError = useCallback(
    (message: string | null) => setActionError(message),
    [],
  );
  const onProviders = useCallback((providers: ProviderSettings) => {
    const current = latest.current;
    if (alive.current && current.payload)
      current.onPayload({ ...current.payload, providers });
  }, []);
  const onNativeProvider = useCallback(
    (provider: string, settings: ProviderSettings) => {
      const current = latest.current;
      if (!alive.current || !current.payload) return;
      const retained = current.payload.providers;
      const next = {
        ...current.payload,
        providers: {
          ...retained,
          statuses: {
            ...retained.statuses,
            [provider]: settings.statuses[provider],
          },
          modelCaches: {
            ...retained.modelCaches,
            [provider]: settings.modelCaches[provider],
          },
        },
      };
      latest.current = { ...current, payload: next };
      current.onPayload(next);
    },
    [],
  );
  useNativeAgentConnections(connection, payload?.providers, onNativeProvider, providerRevision);
  const onPreferences = useCallback(
    (value: { preferences: BootstrapPayload["preferences"] }) => {
      const current = latest.current;
      if (current.payload)
        current.onPayload({
          ...current.payload,
          preferences: value.preferences,
        });
    },
    [],
  );
  const providerActions = useProviderSettings({
    connection,
    onError,
    onPayload,
    onPreferences,
    onProviders,
    preferences: normalizePreferences(payload?.preferences),
    providers: payload?.providers,
  });
  const projectState = useAgentProjects(connection, account, teamId);
  const {
    projects,
    projectId,
    loading: projectLoading,
    error: projectError,
  } = projectState;
  const baseUrl = account?.baseUrl ?? account?.activeProfile?.baseUrl;
  const learningUrl =
    baseUrl && teamId
      ? `${baseUrl.replace(/\/$/u, "")}/console/connections?${new URLSearchParams({ teamId, ...(projectId ? { project: projectId } : {}) })}`
      : null;
  async function service(action: "start" | "stop" | "sync") {
    if (!connection || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiFetch(connection, "/v1/native-history/collector", {
        method: "POST",
        body: JSON.stringify({ command: action }),
      });
      await refresh();
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : "Importer action failed.";
      setActionError(message);
      onToast?.(message, "error");
    } finally {
      setActionBusy(false);
    }
  }
  const provider = selected?.provider;
  const status = provider ? payload?.providers.statuses[provider] : null;
  const conversationPanel = selected ? (
    <AgentConversationSetup
      key={selected.id}
      agent={selected}
      inventory={inventory}
      connection={connection}
      account={account}
      teamId={teamId}
      projects={projects}
      projectId={projectId}
      onRefresh={refresh}
      learningUrl={learningUrl}
    />
  ) : null;
  return (
    <section className="connected-agents-view" aria-label="Connected agents">
      <div className="agent-connections-heading">
        <div>
          <h2>Connected agents</h2>
          <p>Use your installed agents and sync conversations with OpenPond.</p>
        </div>
        <div className="agent-connections-actions">
          <button
            type="button"
            disabled={loading || !connection}
            aria-label="Refresh agent connections"
            onClick={() => {
              void refresh();
              projectState.refresh();
              setProviderRevision(value => value + 1);
            }}
          >
            <RefreshCw size={15} />
          </button>
          <div className="agent-more" ref={moreRef}>
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
            >
              More agents
            </button>
            {moreOpen ? (
              <div className="agent-more-menu">
                {AGENT_SOURCES.filter((item) => hidden.includes(item.id)).map(
                  (item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => {
                        setHidden((items) =>
                          items.filter((id) => id !== item.id),
                        );
                        setMoreOpen(false);
                      }}
                    >
                      <Plus size={14} />
                      <span>{item.name}</span>
                    </button>
                  ),
                )}
                {hidden.length === 0 ? <span>All agents shown</span> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <label className="agent-project-scope">
        Project
        <select
          aria-label="Connections project"
          value={projectId}
          disabled={!projects.length}
          onChange={(event) => projectState.select(event.target.value)}
        >
          <option value="">
            {projectLoading && !projects.length
              ? "Fetching projects…"
              : "Select project"}
          </option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.content.name}
            </option>
          ))}
        </select>
      </label>
      {projectError ? <p role="alert">{projectError}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      <div className="agent-connections-grid">
        {AGENT_SOURCES.filter((item) => !hidden.includes(item.id)).map(
          (agent) => (
            <AgentConnectionCard
              key={agent.id}
              agent={agent}
              account={account}
              native={
                agent.provider
                  ? payload?.providers.statuses[agent.provider]
                  : null
              }
              inventory={inventory}
              projects={projects}
              teamId={teamId}
              learningUrl={learningUrl}
              connected={Boolean(connection)}
              onHide={() => setHidden((items) => [...items, agent.id])}
              onManage={() => setSelected(agent)}
            />
          ),
        )}
      </div>
      {inventory ? (
        <div className="agent-importer-footer">
          <span>
            {inventory.collector.desiredState === "stopped"
              ? "Importer stopped"
              : inventory.collector.running
                ? "Importer running"
                : "Importer offline"}
          </span>
          <button
            type="button"
            disabled={actionBusy || !inventory.collector.running}
            onClick={() => void service("sync")}
          >
            Sync now
          </button>
          <button
            type="button"
            disabled={actionBusy}
            onClick={() =>
              void service(inventory.collector.running ? "stop" : "start")
            }
          >
            {inventory.collector.running ? "Stop" : "Start"} importer
          </button>
          <details>
            <summary>CLI state</summary>
            <code>{inventory.statusCommand}</code>
          </details>
        </div>
      ) : null}
      {selected && provider && status && payload ? (
        <ProviderDetailsDialog
          checkNativeProvider={providerActions.checkNativeProvider}
          connection={connection}
          account={account}
          codex={payload.codex}
          providerId={provider}
          providerBusy={providerActions.providerBusy}
          settings={payload.providers}
          status={status}
          onClose={() => setSelected(null)}
          onDeleteCredential={providerActions.deleteProviderCredential}
          onRefreshModels={providerActions.refreshProviderModels}
          onSaveConfig={providerActions.saveProviderConfig}
          onSaveCredential={providerActions.saveProviderCredential}
          onStartOpenAiSubscriptionAuth={
            providerActions.startOpenAiSubscriptionAuth
          }
          onValidate={providerActions.validateProvider}
          conversationPanel={conversationPanel}
        />
      ) : selected ? (
        <ImportOnlyDialog agent={selected} onClose={() => setSelected(null)}>
          {conversationPanel}
        </ImportOnlyDialog>
      ) : null}
    </section>
  );
}

function ImportOnlyDialog({
  agent,
  onClose,
  children,
}: {
  agent: AgentSource;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useAgentDialogFocus(onClose);
  return (
    <div
      className="git-dialog-backdrop provider-dialog-backdrop"
      onMouseDown={onClose}
    >
      <section
        ref={ref}
        className="git-dialog provider-details-dialog agent-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} connection`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="git-dialog-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <div className="provider-dialog-header"><div><h2>{agent.name}</h2><span>Conversation syncing</span></div></div>
        {children}
      </section>
    </div>
  );
}
