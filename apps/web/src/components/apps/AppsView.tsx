import type {
  AccountState,
  ConnectedAppCatalogEntry,
  ConnectedAppId,
  ConnectedAppStatusRow,
} from "@openpond/contracts";
import {
  buildConnectedAppInstallUrl,
  buildConnectedAppStatusRows,
} from "@openpond/contracts";
import { useEffect, useMemo, useState } from "react";
import "../../styles/apps/apps.css";
import { api, type ClientConnection } from "../../api";
import { connectedAppIconUrl, OPENPOND_ICON_URL } from "../../lib/public-assets";
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Search,
  X,
} from "../icons";

type AppsViewProps = {
  account: AccountState | null;
  connection: ClientConnection | null;
  defaultTeamId?: string | null;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

const APP_FILTERS = ["For agents", "Featured", "Productivity", "Developer tools"] as const;
type AppFilter = (typeof APP_FILTERS)[number];

const FEATURED_APP_IDS = new Set<ConnectedAppId>(["slack", "google", "github", "mcp"]);

export function AppsView({ account, connection, defaultTeamId, onToast }: AppsViewProps) {
  const [selectedApp, setSelectedApp] = useState<ConnectedAppStatusRow | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AppFilter>("For agents");
  const [statusRows, setStatusRows] = useState<ConnectedAppStatusRow[]>(() =>
    buildConnectedAppStatusRows(),
  );
  const [statusState, setStatusState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [statusTeamId, setStatusTeamId] = useState<string | null>(null);
  const accountBaseUrl = account?.baseUrl ?? account?.activeProfile?.baseUrl ?? null;
  const setupTeamId = connectedAppSetupTeamId(defaultTeamId, statusTeamId);
  const filteredApps = useMemo(
    () =>
      statusRows.filter((app) => appMatchesFilter(app, filter)).filter((app) =>
        appMatchesSearch(app, search),
      ),
    [filter, search, statusRows],
  );

  useEffect(() => {
    let active = true;
    if (!connection) {
      setStatusRows(buildConnectedAppStatusRows());
      setStatusState("idle");
      setStatusTeamId(null);
      return () => {
        active = false;
      };
    }
    setStatusState("loading");
    void api
      .connectedAppStatus(connection, {
        status: "all",
      })
      .then((payload) => {
        if (!active) return;
        setStatusRows(payload.apps);
        setStatusTeamId(payload.teamId?.trim() || null);
        setStatusState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        console.warn("Unable to load connected app status.", caught);
        setStatusRows(buildConnectedAppStatusRows());
        setStatusTeamId(null);
        setStatusState("error");
      });
    return () => {
      active = false;
    };
  }, [connection]);

  function openInstallUrl(app: ConnectedAppStatusRow) {
    const url = buildConnectedAppInstallUrl({
      appId: app.id,
      baseUrl: accountBaseUrl,
      teamId: setupTeamId,
    });
    void openExternalUrl(url).catch((caught) => {
      onToast?.(caught instanceof Error ? caught.message : String(caught), "error");
    });
  }

  return (
    <section className="connected-apps-view" aria-label="Apps">
      <div className="connected-apps-header">
        <div>
          <h1>Apps</h1>
          <p>Connect apps that agents can use for chat, knowledge, files, and workflow actions.</p>
        </div>
        <label className="connected-apps-search">
          <Search size={15} />
          <input
            aria-label="Search apps"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search apps"
            type="search"
            value={search}
          />
        </label>
      </div>

      <div className={`connected-apps-status-strip ${statusState}`}>
        <span>{statusStateLabel(statusState)}</span>
        <span>{connectedCount(statusRows)} connected</span>
      </div>

      <section className="connected-apps-hero" aria-label="App context">
        <div className="connected-apps-hero-copy">
          <span className="connected-apps-hero-icon">
            <AppIcon appId="github" />
          </span>
          <h2>Work with your apps</h2>
          <p>Bring repositories, documents, chat, calendars, and custom MCP tools into OpenPond.</p>
        </div>
        <div className="connected-apps-context-card" aria-hidden="true">
          <strong>Agent context</strong>
          <div>
            <span className="files">Files</span>
            <span className="chat">Chat</span>
            <span className="oauth">OAuth</span>
            <span className="mcp">MCP</span>
          </div>
        </div>
      </section>

      <div className="connected-apps-filters" role="tablist" aria-label="App categories">
        {APP_FILTERS.map((item) => (
          <button
            aria-selected={filter === item}
            className={filter === item ? "active" : ""}
            key={item}
            onClick={() => setFilter(item)}
            role="tab"
            type="button"
          >
            {item}
          </button>
        ))}
      </div>

      <div className="connected-apps-list">
        {filteredApps.map((app) => (
          <ConnectedAppRow
            app={app}
            key={app.id}
            onSelect={() => setSelectedApp(app)}
          />
        ))}
        {filteredApps.length === 0 ? <div className="connected-apps-empty">No apps match the current search.</div> : null}
      </div>

      {selectedApp ? (
        <ConnectedAppInstallDialog
          app={selectedApp}
          onClose={() => setSelectedApp(null)}
          onInstall={() => openInstallUrl(selectedApp)}
        />
      ) : null}
    </section>
  );
}

export function connectedAppSetupTeamId(
  defaultTeamId: string | null | undefined,
  statusTeamId: string | null | undefined,
): string | null {
  const explicitTeamId = defaultTeamId?.trim();
  if (explicitTeamId) return explicitTeamId;
  return statusTeamId?.trim() || null;
}

export function ConnectedAppRow({
  app,
  onSelect,
}: {
  app: ConnectedAppStatusRow;
  onSelect: () => void;
}) {
  return (
    <button className="connected-app-row" onClick={onSelect} type="button">
      <span className="connected-app-row-main">
        <AppIcon appId={app.id} />
        <span className="connected-app-copy">
          <span className="connected-app-title">
            <strong>{app.label}</strong>
            <span>
              {app.shortLabel !== app.label ? app.shortLabel : app.category}
              {" / "}
              {app.setupSurfaceLabel}
            </span>
          </span>
          <span>{app.description}</span>
          <span className="connected-app-capability-row">
            {app.capabilityLabels.slice(0, 2).map((label) => (
              <span key={label}>{label}</span>
            ))}
            {app.capabilityLabels.length > 2 ? <span>+{app.capabilityLabels.length - 2}</span> : null}
          </span>
        </span>
      </span>
      <span className={`connected-app-status-pill ${app.status}`}>{app.statusLabel}</span>
      <ChevronRight size={16} />
    </button>
  );
}

function ConnectedAppInstallDialog({
  app,
  onClose,
  onInstall,
}: {
  app: ConnectedAppStatusRow;
  onClose: () => void;
  onInstall: () => void;
}) {
  const activeConnections = app.connections.filter((connection) => connection.status === "active");
  return (
    <div
      className="connected-app-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="connected-app-dialog" role="dialog" aria-modal="true" aria-labelledby="connected-app-dialog-title">
        <button className="connected-app-dialog-close" type="button" aria-label="Close app details" onClick={onClose}>
          <X size={17} />
        </button>
        <div className="connected-app-dialog-identity">
          <span className="openpond-mark">
            <img alt="" src={OPENPOND_ICON_URL} />
          </span>
          <span className="connection-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <AppIcon appId={app.id} />
        </div>
        <h2 id="connected-app-dialog-title">Connect {app.label}</h2>
        <div className="connected-app-approval">
          <CheckCircle2 size={16} />
          <span>{app.statusLabel}</span>
        </div>
        <div className="connected-app-dialog-body">
          <section>
            <h3>{app.setupSurfaceLabel}</h3>
            <p>
              The web flow shows the provider account, workspace, and requested access before anything is connected.
            </p>
          </section>
          <section>
            <h3>Connected account</h3>
            <p>{accountSummary(activeConnections)}</p>
          </section>
          <section>
            <h3>Available capabilities</h3>
            <div className="connected-app-dialog-capabilities">
              {app.capabilities.map((capability) => (
                <span key={capability.id}>{capability.label}</span>
              ))}
            </div>
          </section>
          <section>
            <h3>Sandbox lease policy</h3>
            <p>
              {app.leasePolicy.leaseable
                ? `Leaseable for ${app.leasePolicy.defaultTtlSeconds ?? 0} seconds with scoped proxy access.`
                : "Managed as setup or tool discovery; no OAuth lease is required."}
            </p>
          </section>
        </div>
        <button className="connected-app-dialog-primary" type="button" onClick={onInstall}>
          <span>{app.installLabel}</span>
          <ExternalLink size={15} />
        </button>
      </section>
    </div>
  );
}

function AppIcon({ appId }: { appId: ConnectedAppId }) {
  return (
    <span className={`connected-app-icon app-${appId}`}>
      <img alt="" src={iconSrcForApp(appId)} />
    </span>
  );
}

function appMatchesFilter(app: ConnectedAppCatalogEntry, filter: AppFilter): boolean {
  if (filter === "For agents") return true;
  if (filter === "Featured") return FEATURED_APP_IDS.has(app.id);
  if (filter === "Productivity") return app.category === "Productivity" || app.category === "Chat";
  return app.category === "Developer tools" || app.id === "mcp";
}

function appMatchesSearch(app: ConnectedAppCatalogEntry, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    app.id,
    app.label,
    app.shortLabel,
    app.category,
    app.description,
    app.providerFamily,
    app.setupSurface,
  ].some((value) => value.toLowerCase().includes(query));
}

function iconSrcForApp(appId: ConnectedAppId): string {
  return connectedAppIconUrl(appId);
}

async function openExternalUrl(url: string): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser) {
    const result = await browser.openExternal({ conversationId: "connected-apps", url });
    if (!result.ok) throw new Error(result.error ?? "Unable to open app setup.");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function statusStateLabel(status: "idle" | "loading" | "ready" | "error"): string {
  if (status === "loading") return "Checking connections";
  if (status === "ready") return "Connection status current";
  if (status === "error") return "Connection status unavailable";
  return "Connection status pending";
}

function connectedCount(rows: ConnectedAppStatusRow[]): number {
  return rows.filter((row) => row.connected).length;
}

function accountSummary(connections: ConnectedAppStatusRow["connections"]): string {
  if (connections.length === 0) return "No active OAuth connection for this setup surface.";
  return connections
    .map((connection) => {
      const account = connection.accountLabel ?? "Connected account";
      return connection.workspaceLabel ? `${account} / ${connection.workspaceLabel}` : account;
    })
    .join(", ");
}
