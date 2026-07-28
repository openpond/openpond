import type {
  OpenPondApp,
  TeamChatMember,
} from "@openpond/contracts";

import { actionMentionMatchesForQuery } from "../../lib/action-mentions";
import {
  mentionTokenForChatApp,
  normalizeMentionToken,
} from "../../lib/chat-app-mentions";
import {
  connectedAppMentionMatchesForQuery,
  type ConnectedAppMentionOption,
} from "../../lib/connected-app-mentions";
import { composerActionCatalogLabel } from "../../lib/composer-action-catalog";
import {
  COMPOSER_SLASH_COMMANDS,
  composerSlashCommandMatches,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";
import { profileSkillInvocationMatchesForQuery } from "../../lib/profile-skill-invocations";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type {
  ComposerMentionMenuItem,
} from "./ComposerMentionMenu";
import type { ComposerSkillMenuItem } from "./ComposerSkillMenu";

export type ActiveSlashContext = {
  end: number;
  query: string;
  start: number;
};

export function activeSlashCommandContext(
  input: string,
  cursor: number,
): ActiveSlashContext | null {
  const beforeCursor = input.slice(0, Math.max(0, Math.min(cursor, input.length)));
  const match = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(beforeCursor);
  if (!match || typeof match.index !== "number") return null;
  const slashOffset = match[0].lastIndexOf("/");
  if (slashOffset < 0) return null;
  const start = match.index + slashOffset;
  return {
    end: beforeCursor.length,
    query: (match[1] ?? "").toLowerCase(),
    start,
  };
}

export function completedTypedSlashCommand(
  input: string,
  cursor: number,
  commands: ComposerSlashCommand[] = COMPOSER_SLASH_COMMANDS,
): { command: ComposerSlashCommand; end: number; start: number } | null {
  const beforeCursor = input.slice(0, Math.max(0, Math.min(cursor, input.length)));
  const match = /(?:^|\s)\/([a-z][a-z0-9_-]*)\s$/.exec(beforeCursor);
  if (!match) return null;
  const command = commands.find((candidate) => candidate.id === match[1]);
  if (!command) return null;
  const slashOffset = match[0].lastIndexOf("/");
  if (slashOffset < 0 || typeof match.index !== "number") return null;
  return {
    command,
    end: beforeCursor.length,
    start: match.index + slashOffset,
  };
}

export function slashCommandMatchesForQuery(
  query: string,
  commands: ComposerSlashCommand[] = COMPOSER_SLASH_COMMANDS,
): ComposerSlashCommand[] {
  return composerSlashCommandMatches({ commands, prompt: `/${query}` });
}

export function slashActionMatchesForQuery(
  actions: SandboxActionCatalogEntry[],
  query: string,
): SandboxActionCatalogEntry[] {
  if (actions.length === 0) return [];
  return actions.filter((action) => {
    if (!query) return true;
    return [
      action.id,
      action.name ?? "",
      action.label ?? "",
      action.description ?? "",
      typeof action.implementation?.type === "string"
        ? action.implementation.type
        : "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

export function slashAppContextMatchesForQuery(
  apps: OpenPondApp[],
  query: string,
): OpenPondApp[] {
  if (apps.length === 0) return [];
  return apps
    .filter((app) => {
      if (!query) return true;
      return [
        app.id,
        app.name,
        app.description ?? "",
        app.gitRepo ?? "",
        mentionTokenForChatApp(app),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 8);
}

export function mentionMenuMatchesForQuery({
  actionCatalog,
  connectedAppMentions,
  mentionApps,
  profileSkills,
  query,
  surface,
  teamMentionMembers,
}: {
  actionCatalog: SandboxActionCatalogEntry[];
  connectedAppMentions: ConnectedAppMentionOption[];
  mentionApps: OpenPondApp[];
  profileSkills: ComposerSkillMenuItem[];
  query: string;
  surface: "chat" | "team";
  teamMentionMembers: TeamChatMember[];
}): ComposerMentionMenuItem[] {
  const needle = query.toLowerCase();
  if (surface === "team") {
    const memberMatches = teamMentionMembers
      .filter((member) => {
        if (!needle) return true;
        return [member.name, member.handle ?? ""]
          .map(normalizeMentionToken)
          .some((token) => token.includes(needle));
      })
      .map((member) => ({ kind: "team-member" as const, member }));
    const teamActionMatches = actionMentionMatchesForQuery(
      actionCatalog,
      needle,
      actionCatalog.length,
    ).map((action) => ({ kind: "action" as const, action }));
    return [...teamActionMatches, ...memberMatches];
  }
  const appMatches = mentionApps
    .filter((app) => {
      if (!needle) return true;
      const tokens = [
        normalizeMentionToken(app.id),
        normalizeMentionToken(app.name),
        app.gitRepo ? normalizeMentionToken(app.gitRepo) : "",
        mentionTokenForChatApp(app),
      ];
      return tokens.some((token) => token.includes(needle));
    })
    .map((app) => ({ kind: "app" as const, app }));
  const actionMatches = actionMentionMatchesForQuery(
    actionCatalog,
    needle,
    actionCatalog.length,
  ).map((action) => ({ kind: "action" as const, action }));
  const skillMatches = profileSkillInvocationMatchesForQuery(profileSkills, needle)
    .map((skill) => ({ kind: "skill" as const, skill }));
  const connectedAppMatches = connectedAppMentionMatchesForQuery(
    connectedAppMentions,
    needle,
  ).map((app) => ({ kind: "connected-app" as const, app }));
  return [
    ...actionMatches,
    ...skillMatches,
    ...appMatches,
    ...connectedAppMatches,
  ];
}

export function promptWithSelectedInvocationText(
  prompt: string,
  invocationText: string | null,
  position: number | null,
): string {
  const invocation = invocationText?.trim();
  if (!invocation) return prompt;
  const insertionPoint = Math.max(0, Math.min(position ?? 0, prompt.length));
  const before = prompt.slice(0, insertionPoint);
  const after = prompt.slice(insertionPoint);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  return `${before}${prefix}${invocation}${suffix}${after}`
    .replace(/\s+/g, " ")
    .trim();
}

function synthesizedActionMentionText(
  action: SandboxActionCatalogEntry,
): string | null {
  const token = normalizeMentionToken(
    composerActionCatalogLabel(action) || action.name || action.id,
  );
  return token ? `@${token}` : null;
}

export function humanizeSelectedActionInput(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return prompt;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return prompt;
    const parts = Object.entries(parsed)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(
        ([key, value]) =>
          `${actionInputLabel(key)}: ${actionInputValue(key, value)}`,
      );
    return parts.length ? parts.join(" · ") : prompt;
  } catch {
    return prompt;
  }
}

function actionInputLabel(key: string): string {
  const words = key
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .trim()
    .toLowerCase();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Input";
}

function actionInputValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => actionInputValue(key, item)).join(", ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(
        ([nestedKey, nestedValue]) =>
          `${actionInputLabel(nestedKey)}: ${actionInputValue(nestedKey, nestedValue)}`,
      )
      .join(" · ");
  }
  const text = String(value);
  if (/Id$/.test(key) && /^[a-z0-9_-]+$/i.test(text)) {
    return text
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }
  return text;
}

export function selectedActionDisplayPrompt({
  action,
  prompt,
  selectedActionMentionText,
  selectedInvocationPosition,
}: {
  action: SandboxActionCatalogEntry | null;
  prompt: string;
  selectedActionMentionText: string | null;
  selectedInvocationPosition: number | null;
}): string | null {
  if (!action) return null;
  const explicitMention = selectedActionMentionText?.trim();
  const mentionText = explicitMention?.startsWith("@")
    ? explicitMention
    : synthesizedActionMentionText(action);
  return mentionText
    ? promptWithSelectedInvocationText(
        humanizeSelectedActionInput(prompt),
        mentionText,
        selectedInvocationPosition,
      )
    : null;
}

export function hasComposerSubmittableInput({
  attachmentCount,
  prompt,
  selectedAction,
  selectedCommand,
}: {
  attachmentCount: number;
  prompt: string;
  selectedAction: SandboxActionCatalogEntry | null;
  selectedCommand: ComposerSlashCommand | null;
}): boolean {
  return Boolean(
    prompt.trim() || attachmentCount > 0 || selectedAction || selectedCommand,
  );
}
