import type { SandboxActionCatalogEntry } from "./sandbox-types";
import {
  composerActionCatalogHint,
  composerActionCatalogLabel,
} from "./composer-action-catalog";
import { normalizeMentionToken } from "./chat-app-mentions";

export type MentionedActionResolution = {
  action: SandboxActionCatalogEntry;
  mention: string;
  prompt: string;
};

const GENERIC_ACTION_MENTION_TOKENS = new Set([
  "action",
  "agent",
  "chat",
  "customer",
  "default",
  "filter",
  "items",
  "open",
  "openpond",
  "profile",
  "run",
  "summarize",
  "track",
  "workflow",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function addNormalizedToken(tokens: Set<string>, value: unknown, options: { generic?: boolean } = {}) {
  const token = text(value) ? normalizeMentionToken(String(value)) : "";
  if (!token) return;
  if (!options.generic && GENERIC_ACTION_MENTION_TOKENS.has(token)) return;
  tokens.add(token);
}

function addSegmentTokens(tokens: Set<string>, value: unknown) {
  const source = text(value);
  if (!source) return;
  for (const segment of source.split(/[.:/\\\s]+/g)) {
    addNormalizedToken(tokens, segment);
  }
}

function addWordTokens(tokens: Set<string>, value: unknown) {
  const source = text(value);
  if (!source) return;
  for (const word of source.split(/[^A-Za-z0-9_-]+/g)) {
    if (word.length < 4) continue;
    addNormalizedToken(tokens, word);
  }
}

export function actionMentionTokens(action: SandboxActionCatalogEntry): Set<string> {
  const tokens = new Set<string>();
  const implementation = asRecord(action.implementation);
  const implementationActionId = text(implementation?.actionId);

  addNormalizedToken(tokens, action.id, { generic: true });
  addSegmentTokens(tokens, action.id);
  addNormalizedToken(tokens, implementationActionId, { generic: true });
  addSegmentTokens(tokens, implementationActionId);
  addNormalizedToken(tokens, action.name, { generic: true });
  addSegmentTokens(tokens, action.name);
  addNormalizedToken(tokens, action.label, { generic: true });
  addSegmentTokens(tokens, action.label);
  addWordTokens(tokens, action.description);

  return tokens;
}

export function actionMentionSearchText(action: SandboxActionCatalogEntry): string {
  const implementation = asRecord(action.implementation);
  return [
    action.id,
    action.name ?? "",
    action.label ?? "",
    action.description ?? "",
    text(implementation?.actionId) ?? "",
    text(implementation?.agentName) ?? "",
    composerActionCatalogHint(action),
    ...Array.from(actionMentionTokens(action)),
  ]
    .join(" ")
    .toLowerCase();
}

export function actionMentionMatchesForQuery(
  actions: SandboxActionCatalogEntry[],
  query: string,
  limit = 8,
): SandboxActionCatalogEntry[] {
  const normalizedQuery = normalizeMentionToken(query);
  if (actions.length === 0) return [];
  return actions
    .filter((action) => {
      if (!normalizedQuery) return true;
      return actionMentionSearchText(action).includes(normalizedQuery);
    })
    .slice(0, limit);
}

function extractMentionTokens(prompt: string): string[] {
  return Array.from(prompt.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g))
    .map((match) => normalizeMentionToken(match[1] ?? ""))
    .filter(Boolean);
}

function stripMention(prompt: string, mention: string): string {
  const escapedMention = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt
    .replace(new RegExp(`(^|\\s)@${escapedMention}(?=\\s|$)`, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveMentionedAction(
  prompt: string,
  actions: SandboxActionCatalogEntry[],
): MentionedActionResolution | null {
  const mentions = extractMentionTokens(prompt);
  if (mentions.length === 0 || actions.length === 0) return null;

  const matches = new Map<string, { action: SandboxActionCatalogEntry; mention: string }>();
  for (const mention of mentions) {
    for (const action of actions) {
      if (actionMentionTokens(action).has(mention)) {
        matches.set(action.id, { action, mention });
      }
    }
  }

  if (matches.size !== 1) return null;
  const match = Array.from(matches.values())[0]!;
  return {
    action: match.action,
    mention: match.mention,
    prompt: stripMention(prompt, match.mention),
  };
}

export function actionMentionLabel(action: SandboxActionCatalogEntry): string {
  return composerActionCatalogLabel(action);
}

export function actionMentionDetail(action: SandboxActionCatalogEntry): string {
  return action.description || composerActionCatalogHint(action);
}
