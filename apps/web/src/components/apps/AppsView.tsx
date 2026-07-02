import type { AccountState, ConnectedAppCatalogEntry, ConnectedAppId } from "@openpond/contracts";
import {
  buildConnectedAppInstallUrl,
  CONNECTED_APP_CATALOG,
} from "@openpond/contracts";
import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Search,
  X,
} from "../icons";

type AppsViewProps = {
  account: AccountState | null;
  defaultTeamId?: string | null;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

const APP_FILTERS = ["For agents", "Featured", "Productivity", "Developer tools"] as const;
type AppFilter = (typeof APP_FILTERS)[number];

const FEATURED_APP_IDS = new Set<ConnectedAppId>(["slack", "google", "github", "mcp"]);

export function AppsView({ account, defaultTeamId, onToast }: AppsViewProps) {
  const [selectedApp, setSelectedApp] = useState<ConnectedAppCatalogEntry | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AppFilter>("For agents");
  const accountBaseUrl = account?.baseUrl ?? account?.activeProfile?.baseUrl ?? null;
  const filteredApps = useMemo(
    () =>
      CONNECTED_APP_CATALOG.filter((app) => appMatchesFilter(app, filter)).filter((app) =>
        appMatchesSearch(app, search),
      ),
    [filter, search],
  );

  function openInstallUrl(app: ConnectedAppCatalogEntry) {
    const url = buildConnectedAppInstallUrl({
      appId: app.id,
      baseUrl: accountBaseUrl,
      teamId: defaultTeamId,
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

function ConnectedAppRow({
  app,
  onSelect,
}: {
  app: ConnectedAppCatalogEntry;
  onSelect: () => void;
}) {
  return (
    <button className="connected-app-row" onClick={onSelect} type="button">
      <span className="connected-app-row-main">
        <AppIcon appId={app.id} />
        <span className="connected-app-copy">
          <span className="connected-app-title">
            <strong>{app.label}</strong>
            <span>{app.shortLabel !== app.label ? app.shortLabel : app.category}</span>
          </span>
          <span>{app.description}</span>
        </span>
      </span>
      <ChevronRight size={16} />
    </button>
  );
}

function ConnectedAppInstallDialog({
  app,
  onClose,
  onInstall,
}: {
  app: ConnectedAppCatalogEntry;
  onClose: () => void;
  onInstall: () => void;
}) {
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
            <img alt="" src="/openpond-icon.png" />
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
          <span>Review setup in OpenPond web</span>
        </div>
        <div className="connected-app-dialog-body">
          <section>
            <h3>Connection setup</h3>
            <p>
              The web flow shows the provider account, workspace, and requested access before anything is connected.
            </p>
          </section>
          <section>
            <h3>Agent access</h3>
            <p>
              Agents can use this app only when a profile, project, or conversation is configured to include it.
            </p>
          </section>
          <section>
            <h3>Context sent to the app</h3>
            <p>
              OpenPond sends the selected app the workspace and request context needed for the action you approve.
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
  return [app.id, app.label, app.shortLabel, app.category, app.description].some((value) =>
    value.toLowerCase().includes(query),
  );
}

function iconSrcForApp(appId: ConnectedAppId): string {
  if (appId === "slack" || appId === "slack_oauth") return "/connected-apps/slack.svg";
  if (appId === "microsoft_teams" || appId === "microsoft_teams_oauth") return "/connected-apps/microsoft.svg";
  if (appId === "github") return "/connected-apps/github.svg";
  if (appId === "google") return "/connected-apps/google.svg";
  if (appId === "linear") return "/connected-apps/linear.svg";
  if (appId === "notion") return "/connected-apps/notion.svg";
  if (appId === "x") return "/connected-apps/x.svg";
  return "/connected-apps/openpond-mcp.svg";
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
