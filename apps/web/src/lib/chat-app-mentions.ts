import type { OpenPondApp } from "@openpond/contracts";

export function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function mentionTokenForChatApp(app: Pick<OpenPondApp, "id" | "name" | "gitRepo">): string {
  return normalizeMentionToken(app.name || app.gitRepo || app.id);
}

export function mentionTextForChatApp(app: Pick<OpenPondApp, "id" | "name" | "gitRepo">): string {
  return `@${mentionTokenForChatApp(app)}`;
}

function extractMentionTokens(prompt: string): string[] {
  return Array.from(prompt.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+)/g))
    .map((match) => normalizeMentionToken(match[1] ?? ""))
    .filter(Boolean);
}

export function promptContainsChatAppMention(prompt: string, app: Pick<OpenPondApp, "id" | "name" | "gitRepo">): boolean {
  const mentions = extractMentionTokens(prompt);
  if (mentions.length === 0) return false;
  const appTokens = new Set([
    normalizeMentionToken(app.id),
    mentionTokenForChatApp(app),
    app.gitRepo ? normalizeMentionToken(app.gitRepo) : "",
  ].filter(Boolean));
  return mentions.some((mention) => appTokens.has(mention));
}

export function sandboxMentionApps(apps: OpenPondApp[]): OpenPondApp[] {
  return apps.filter((app) => app.sandbox);
}

export function resolveMentionedChatApp(
  prompt: string,
  apps: OpenPondApp[],
): OpenPondApp | null {
  const mentions = extractMentionTokens(prompt);
  if (mentions.length === 0) return null;

  const matches = new Map<string, OpenPondApp>();
  for (const mention of mentions) {
    const app = apps.find((candidate) => {
      const id = normalizeMentionToken(candidate.id);
      const name = normalizeMentionToken(candidate.name);
      const repo = candidate.gitRepo ? normalizeMentionToken(candidate.gitRepo) : "";
      return mention === id || mention === name || mention === repo;
    });
    if (app) matches.set(app.id, app);
  }

  return matches.size === 1 ? Array.from(matches.values())[0] ?? null : null;
}

export function activeMentionQuery(value: string, cursor: number): { query: string; start: number } | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || typeof match.index !== "number") return null;
  const atOffset = beforeCursor.slice(match.index).indexOf("@");
  if (atOffset < 0) return null;
  return {
    query: normalizeMentionToken(match[1] ?? ""),
    start: match.index + atOffset,
  };
}
