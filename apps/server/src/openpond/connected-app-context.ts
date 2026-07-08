import type {
  ConnectedAppCapability,
  ConnectedAppConnectionLike,
  ConnectedAppProviderFamilyId,
  ConnectedAppSetupSurface,
  ConnectedAppStatusConnection,
  ConnectedAppStatusRow,
  MentionedConnectedAppRef,
} from "@openpond/contracts";
import { buildConnectedAppStatusRows } from "@openpond/contracts";

export type ResolvedConnectedAppContext = {
  provider: ConnectedAppProviderFamilyId;
  label: string;
  appIds: string[];
  setupSurfaces: ConnectedAppSetupSurface[];
  accountLabels: string[];
  workspaceLabels: string[];
  capabilities: Pick<ConnectedAppCapability, "access" | "id" | "label">[];
  toolNames: string[];
  connectionIds: string[];
};

const PROVIDER_TOKEN_ALIASES: Record<ConnectedAppProviderFamilyId, string[]> = {
  slack: ["slack"],
  microsoft_teams: ["teams", "microsoft-teams", "microsoft_teams"],
  github: ["github", "gh"],
  google: ["google", "drive", "google-drive", "docs"],
  x: ["x", "twitter"],
  mcp: ["mcp", "openpond-mcp"],
};

export function promptMentionsConnectedAppProvider(prompt: string | null | undefined): boolean {
  const mentions = extractMentionTokens(prompt ?? "");
  if (mentions.length === 0) return false;
  const providerTokens = new Set(
    Object.entries(PROVIDER_TOKEN_ALIASES)
      .filter(([provider]) => provider !== "slack" && provider !== "microsoft_teams" && provider !== "mcp")
      .flatMap(([provider, aliases]) => [provider, ...aliases])
      .map(normalizeMentionToken)
      .filter(Boolean),
  );
  return mentions.some((mention) => providerTokens.has(mention));
}

export function mentionedConnectedAppRefsFromPrompt(input: {
  prompt: string | null | undefined;
  connections?: ConnectedAppConnectionLike[] | null;
}): MentionedConnectedAppRef[] {
  const mentions = new Set(extractMentionTokens(input.prompt ?? ""));
  if (mentions.size === 0) return [];

  const rows = buildConnectedAppStatusRows({ connections: input.connections ?? [] });
  const refsByProvider = new Map<ConnectedAppProviderFamilyId, MentionedConnectedAppRef>();
  for (const row of rows) {
    if (!row.connected || row.statusSource !== "integration_connection") continue;
    if (!rowMentionTokens(row).some((token) => mentions.has(token))) continue;

    const activeConnectionIds = row.connections
      .filter((connection) => connection.status === "active")
      .map((connection) => connection.id)
      .filter(isString);
    if (activeConnectionIds.length === 0) continue;

    const existing = refsByProvider.get(row.providerFamily);
    refsByProvider.set(row.providerFamily, {
      kind: "integration",
      provider: row.providerFamily,
      appIds: uniqueStrings([...(existing?.appIds ?? []), row.id]),
      setupSurfaces: uniqueStrings([...(existing?.setupSurfaces ?? []), row.setupSurface]),
      connectionIds: uniqueStrings([...(existing?.connectionIds ?? []), ...activeConnectionIds]),
      capabilities: uniqueStrings([
        ...(existing?.capabilities ?? []),
        ...row.capabilities.map((capability) => capability.id),
      ]),
    });
  }
  return Array.from(refsByProvider.values());
}

export function resolveMentionedConnectedAppContexts(input: {
  mentionedRefs?: MentionedConnectedAppRef[] | null;
  connections?: ConnectedAppConnectionLike[] | null;
  toolNamesByProvider?: Partial<Record<ConnectedAppProviderFamilyId, string[]>>;
}): ResolvedConnectedAppContext[] {
  const refs = dedupeMentionedRefs(input.mentionedRefs ?? []);
  if (refs.length === 0) return [];

  const rows = buildConnectedAppStatusRows({ connections: input.connections ?? [] });
  return refs.flatMap((ref) => {
    const matchingRows = rows.filter(
      (row) =>
        row.providerFamily === ref.provider &&
        row.statusSource === "integration_connection" &&
        row.connected &&
        ref.appIds.includes(row.id) &&
        ref.setupSurfaces.includes(row.setupSurface),
    );
    if (matchingRows.length === 0) return [];

    const connections = activeConnectionsForRef(matchingRows, ref);
    if (connections.length === 0) return [];

    const allowedCapabilities = uniqueCapabilities(
      matchingRows.flatMap((row) => row.capabilities),
    );
    const requestedCapabilities = new Set(ref.capabilities ?? []);
    const capabilities = requestedCapabilities.size > 0
      ? allowedCapabilities.filter((capability) => requestedCapabilities.has(capability.id))
      : allowedCapabilities;
    if (capabilities.length === 0 && (ref.capabilities?.length ?? 0) > 0) return [];

    return [{
      provider: ref.provider,
      label: matchingRows[0]?.providerLabel ?? ref.provider,
      appIds: uniqueStrings(matchingRows.map((row) => row.id)),
      setupSurfaces: uniqueStrings(matchingRows.map((row) => row.setupSurface)),
      accountLabels: uniqueStrings(connections.map((connection) => connection.accountLabel).filter(isString)),
      workspaceLabels: uniqueStrings(connections.map((connection) => connection.workspaceLabel).filter(isString)),
      capabilities: capabilities.map((capability) => ({
        access: capability.access,
        id: capability.id,
        label: capability.label,
      })),
      toolNames: uniqueStrings(input.toolNamesByProvider?.[ref.provider] ?? []),
      connectionIds: uniqueStrings(connections.map((connection) => connection.id).filter(isString)),
    }];
  });
}

export function buildConnectedAppIndexContext(
  contexts: ResolvedConnectedAppContext[],
): string | null {
  if (contexts.length === 0) return null;
  const lines = [
    "Connected apps available in this turn:",
    "- These connected accounts were re-resolved by the server from trusted account/team state.",
    "- Raw OAuth tokens, refresh tokens, cookies, and provider secrets are not available.",
    "- A user @mention of a connected app is an explicit request to use that connected app before generic web search, browser, or unrelated workspace tools.",
    "- Use only native provider tools whose names are listed for a provider. If no tool is listed, treat the app as connected status/capability context only.",
    "- When connected_app_skill_read is listed, call it before following provider-specific connected app instructions.",
    "- For read/search tasks, prefer connected_app_search and connected_app_read for the mentioned provider; do not substitute web_search for provider data unless the connected app tools fail or cannot satisfy the request.",
  ];
  for (const context of contexts) {
    const accounts = context.accountLabels.length > 0 ? context.accountLabels.join(", ") : "account connected";
    const workspaces = context.workspaceLabels.length > 0 ? `; workspaces: ${context.workspaceLabels.join(", ")}` : "";
    const capabilities = context.capabilities.length > 0
      ? context.capabilities.map((capability) => `${capability.label} (${capability.id})`).join(", ")
      : "none listed";
    const tools = context.toolNames.length > 0 ? context.toolNames.join(", ") : "none registered";
    lines.push(`- ${context.label} (${context.provider}): accounts: ${accounts}${workspaces}; capabilities: ${capabilities}; tools: ${tools}.`);
  }
  return lines.join("\n");
}

function activeConnectionsForRef(
  rows: ConnectedAppStatusRow[],
  ref: MentionedConnectedAppRef,
): ConnectedAppStatusConnection[] {
  const requestedConnectionIds = new Set(ref.connectionIds ?? []);
  const activeConnections = rows
    .flatMap((row) => row.connections)
    .filter((connection) => connection.status === "active");
  if (requestedConnectionIds.size === 0) return activeConnections;
  return activeConnections.filter(
    (connection) => connection.id && requestedConnectionIds.has(connection.id),
  );
}

function dedupeMentionedRefs(refs: MentionedConnectedAppRef[]): MentionedConnectedAppRef[] {
  const byProvider = new Map<ConnectedAppProviderFamilyId, MentionedConnectedAppRef>();
  for (const ref of refs) {
    if (!byProvider.has(ref.provider)) byProvider.set(ref.provider, ref);
  }
  return Array.from(byProvider.values());
}

function uniqueCapabilities(capabilities: ConnectedAppCapability[]): ConnectedAppCapability[] {
  const byId = new Map<string, ConnectedAppCapability>();
  for (const capability of capabilities) {
    if (!byId.has(capability.id)) byId.set(capability.id, capability);
  }
  return Array.from(byId.values());
}

function uniqueStrings<const T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function rowMentionTokens(row: ConnectedAppStatusRow): string[] {
  return uniqueStrings([
    ...PROVIDER_TOKEN_ALIASES[row.providerFamily],
    row.providerFamily,
    row.id,
    row.label,
    row.shortLabel,
  ].map(normalizeMentionToken).filter(Boolean));
}

function extractMentionTokens(prompt: string): string[] {
  return Array.from(prompt.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g))
    .map((match) => normalizeMentionToken(match[1] ?? ""))
    .filter(Boolean);
}

function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
