import type {
  ConnectedAppProviderFamilyId,
  ConnectedAppStatusRow,
  MentionedConnectedAppRef,
} from "@openpond/contracts";
import { normalizeMentionToken } from "./chat-app-mentions";

export type ConnectedAppMentionOption = {
  provider: ConnectedAppProviderFamilyId;
  label: string;
  detail: string;
  token: string;
  tokens: string[];
  ref: MentionedConnectedAppRef;
};

export type ConnectedAppMentionRange = {
  detail: string;
  displayText: string;
  end: number;
  label: string;
  provider: ConnectedAppProviderFamilyId;
  start: number;
  text: string;
};

const PROVIDER_TOKEN_ALIASES: Record<ConnectedAppProviderFamilyId, string[]> = {
  slack: ["slack"],
  microsoft_teams: ["teams", "microsoft-teams", "microsoft_teams"],
  github: ["github", "gh"],
  google: ["google", "drive", "google-drive", "docs"],
  x: ["x", "twitter"],
  mcp: ["mcp", "openpond-mcp"],
};

export function connectedAppMentionText(option: ConnectedAppMentionOption): string {
  return `@${option.token}`;
}

export function connectedAppMentionDisplayText(
  option: Pick<ConnectedAppMentionOption, "label" | "provider">,
): string {
  return `@${connectedAppMentionDisplayLabel(option)}`;
}

export function connectedAppMentionOptionsFromStatusRows(
  rows: ConnectedAppStatusRow[],
): ConnectedAppMentionOption[] {
  const groups = new Map<ConnectedAppProviderFamilyId, ConnectedAppStatusRow[]>();
  for (const row of rows) {
    if (!row.connected || row.statusSource !== "integration_connection") continue;
    const existing = groups.get(row.providerFamily) ?? [];
    existing.push(row);
    groups.set(row.providerFamily, existing);
  }

  return Array.from(groups.entries()).map(([provider, providerRows]) => {
    const first = providerRows[0]!;
    const capabilities = unique(providerRows.flatMap((row) => row.capabilities.map((capability) => capability.id)));
    const capabilityLabels = unique(providerRows.flatMap((row) => row.capabilityLabels));
    const connectionIds = unique(providerRows.flatMap((row) => row.connections.map((connection) => connection.id).filter(isString)));
    const appIds = unique(providerRows.map((row) => row.id));
    const setupSurfaces = unique(providerRows.map((row) => row.setupSurface));
    const token = providerPrimaryToken(provider);
    return {
      provider,
      label: first.providerLabel,
      detail:
        capabilityLabels.length > 0
          ? capabilityLabels.slice(0, 4).join(", ")
          : first.description,
      token,
      tokens: connectedAppMentionTokens(providerRows),
      ref: {
        kind: "integration",
        provider,
        appIds,
        setupSurfaces,
        ...(connectionIds.length > 0 ? { connectionIds } : {}),
        ...(capabilities.length > 0 ? { capabilities } : {}),
      },
    };
  });
}

export function connectedAppMentionMatchesForQuery(
  options: ConnectedAppMentionOption[],
  query: string,
): ConnectedAppMentionOption[] {
  const needle = normalizeMentionToken(query);
  return options
    .filter((option) => {
      if (!needle) return true;
      return option.tokens.some((token) => token.includes(needle));
    })
    .slice(0, 8);
}

export function resolveMentionedConnectedApps(
  prompt: string,
  options: ConnectedAppMentionOption[],
): ConnectedAppMentionOption[] {
  const mentions = extractMentionTokens(prompt);
  if (mentions.length === 0) return [];

  const matches = new Map<ConnectedAppProviderFamilyId, ConnectedAppMentionOption>();
  for (const mention of mentions) {
    const option = options.find((candidate) => candidate.tokens.includes(mention));
    if (option) matches.set(option.provider, option);
  }
  return Array.from(matches.values());
}

export function detectConnectedAppMentionRanges(
  prompt: string,
  options: ConnectedAppMentionOption[],
): ConnectedAppMentionRange[] {
  if (options.length === 0) return [];

  const ranges: ConnectedAppMentionRange[] = [];
  for (const match of prompt.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g)) {
    const rawToken = match[1] ?? "";
    const token = normalizeMentionToken(rawToken);
    if (!token) continue;
    const option = options.find((candidate) => candidate.tokens.includes(token));
    if (!option) continue;
    const fullMatch = match[0] ?? "";
    const atOffset = fullMatch.indexOf("@");
    if (atOffset < 0 || typeof match.index !== "number") continue;
    const start = match.index + atOffset;
    const text = `@${rawToken}`;
    ranges.push({
      detail: option.detail,
      displayText: connectedAppMentionDisplayText(option),
      end: start + text.length,
      label: option.label,
      provider: option.provider,
      start,
      text,
    });
  }
  return ranges;
}

function connectedAppMentionTokens(rows: ConnectedAppStatusRow[]): string[] {
  return unique(
    rows.flatMap((row) => [
      ...PROVIDER_TOKEN_ALIASES[row.providerFamily],
      row.providerFamily,
      row.id,
      row.label,
      row.shortLabel,
    ]).map(normalizeMentionToken).filter(Boolean),
  );
}

function providerPrimaryToken(provider: ConnectedAppProviderFamilyId): string {
  return normalizeMentionToken(PROVIDER_TOKEN_ALIASES[provider][0] ?? provider);
}

function connectedAppMentionDisplayLabel(
  option: Pick<ConnectedAppMentionOption, "label" | "provider">,
): string {
  if (option.provider === "github") return "GitHub";
  if (option.provider === "x") return "X";
  if (option.provider === "mcp") return "MCP";
  return option.label;
}

function extractMentionTokens(prompt: string): string[] {
  return Array.from(prompt.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g))
    .map((match) => normalizeMentionToken(match[1] ?? ""))
    .filter(Boolean);
}

function unique<const T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
