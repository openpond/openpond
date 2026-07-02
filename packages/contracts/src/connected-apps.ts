export type ConnectedAppKind = "native" | "oauth" | "mcp";

export type ConnectedAppId =
  | "slack"
  | "slack_oauth"
  | "microsoft_teams"
  | "microsoft_teams_oauth"
  | "github"
  | "google"
  | "linear"
  | "notion"
  | "x"
  | "mcp";

export type ConnectedAppCatalogEntry = {
  id: ConnectedAppId;
  label: string;
  shortLabel: string;
  kind: ConnectedAppKind;
  category: string;
  description: string;
  deepLinkAppId?: string;
  installLabel: string;
};

export const CONNECTED_APP_CATALOG: ConnectedAppCatalogEntry[] = [
  {
    id: "slack",
    label: "Slack",
    shortLabel: "Slack",
    kind: "native",
    category: "Chat",
    description: "Slack app installed. Bind a channel or thread to an OpenPond profile.",
    installLabel: "Continue to Slack details",
  },
  {
    id: "google",
    label: "Google",
    shortLabel: "Google",
    kind: "oauth",
    category: "Productivity",
    description: "Docs, Drive files, and comments for sandbox workflows.",
    installLabel: "Continue to Google details",
  },
  {
    id: "github",
    label: "GitHub",
    shortLabel: "GitHub",
    kind: "oauth",
    category: "Developer tools",
    description: "Access repositories, issues, and pull requests.",
    installLabel: "Continue to GitHub details",
  },
  {
    id: "linear",
    label: "Linear",
    shortLabel: "Linear",
    kind: "oauth",
    category: "Productivity",
    description: "Viewer and issue access for planning context.",
    installLabel: "Continue to Linear details",
  },
  {
    id: "x",
    label: "X",
    shortLabel: "X",
    kind: "oauth",
    category: "Productivity",
    description: "User profile, mentions, and approved reply access.",
    installLabel: "Continue to X details",
  },
  {
    id: "microsoft_teams",
    label: "Teams",
    shortLabel: "Teams",
    kind: "native",
    category: "Chat",
    description: "Look up chats and messages, then bind conversations to profiles.",
    installLabel: "Continue to Teams details",
  },
  {
    id: "slack_oauth",
    label: "Slack",
    shortLabel: "Slack OAuth",
    kind: "oauth",
    category: "Productivity",
    deepLinkAppId: "oauth:slack",
    description: "Thread and channel history, plus approved thread replies.",
    installLabel: "Continue to Slack OAuth details",
  },
  {
    id: "microsoft_teams_oauth",
    label: "Microsoft Teams",
    shortLabel: "Teams OAuth",
    kind: "oauth",
    category: "Productivity",
    deepLinkAppId: "oauth:microsoft_teams",
    description: "Teams, channels, and message history for team context.",
    installLabel: "Continue to Microsoft Teams details",
  },
  {
    id: "notion",
    label: "Notion",
    shortLabel: "Notion",
    kind: "oauth",
    category: "Productivity",
    description: "Page and block reads for workspace knowledge.",
    installLabel: "Continue to Notion details",
  },
  {
    id: "mcp",
    label: "OpenPond MCP",
    shortLabel: "MCP",
    kind: "mcp",
    category: "Tools",
    description: "Expose workspace tools through a team-scoped MCP endpoint.",
    installLabel: "Open MCP settings",
  },
];

export const DEFAULT_OPENPOND_WEB_BASE_URL = "https://openpond.ai";

export function connectedAppById(appId: string | null | undefined): ConnectedAppCatalogEntry | null {
  const normalized = normalizeConnectedAppId(appId);
  if (!normalized) return null;
  return CONNECTED_APP_CATALOG.find((app) => app.id === normalized) ?? null;
}

export function buildConnectedAppInstallUrl(input: {
  appId: ConnectedAppId;
  baseUrl?: string | null;
  teamId?: string | null;
}): string {
  const app = connectedAppById(input.appId);
  const baseUrl = normalizeOpenPondWebBaseUrl(input.baseUrl);
  const path = app?.kind === "mcp" ? "/sandboxes/mcp" : "/sandboxes/apps";
  const url = new URL(path, baseUrl);
  if (app?.kind !== "mcp") {
    url.searchParams.set("app", app?.deepLinkAppId ?? input.appId);
  }
  const teamId = input.teamId?.trim();
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

function normalizeConnectedAppId(value: string | null | undefined): ConnectedAppId | null {
  const normalized = value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!normalized) return null;
  if (normalized === "teams" || normalized === "microsoft") return "microsoft_teams";
  if (normalized === "slack_oauth" || normalized === "oauth:slack") return "slack_oauth";
  if (normalized === "teams_oauth" || normalized === "oauth:teams") return "microsoft_teams_oauth";
  if (normalized === "microsoft_teams_oauth" || normalized === "oauth:microsoft_teams") {
    return "microsoft_teams_oauth";
  }
  return CONNECTED_APP_CATALOG.some((app) => app.id === normalized) ? (normalized as ConnectedAppId) : null;
}

function normalizeOpenPondWebBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_OPENPOND_WEB_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_OPENPOND_WEB_BASE_URL;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return DEFAULT_OPENPOND_WEB_BASE_URL;
  }
}
