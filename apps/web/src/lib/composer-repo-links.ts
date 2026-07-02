export type ComposerRepoLinkProvider = "github" | "openpond";

export type ComposerRepoLink = {
  end: number;
  host: string;
  label: string;
  provider: ComposerRepoLinkProvider;
  repo: string;
  start: number;
  url: string;
  owner: string;
};

const WEB_REPO_URL_PATTERN = /\b(?:https?:\/\/)?(?:github\.com|(?:[a-z0-9-]+\.)*openpond\.ai)\/[^\s<>"'`]+/gi;
const SCP_REPO_URL_PATTERN = /\b(?:git@)?(?:github\.com|(?:[a-z0-9-]+\.)*openpond\.ai):[^\s<>"'`]+/gi;

const GITHUB_RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "codespaces",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "mobile",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "readme",
  "search",
  "settings",
  "sponsors",
  "team",
  "topics",
  "trending",
]);

const OPENPOND_RESERVED_OWNERS = new Set([
  "account",
  "api",
  "dashboard",
  "docs",
  "install.sh",
  "login",
  "logout",
  "opchat",
  "sandboxes",
  "settings",
]);

function repoProviderForHost(host: string): ComposerRepoLinkProvider | null {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  if (normalized === "github.com") return "github";
  if (normalized === "openpond.ai" || normalized.endsWith(".openpond.ai")) return "openpond";
  return null;
}

function reservedOwnersForProvider(provider: ComposerRepoLinkProvider): Set<string> {
  return provider === "github" ? GITHUB_RESERVED_OWNERS : OPENPOND_RESERVED_OWNERS;
}

function trimTrailingUrlPunctuation(value: string): string {
  let next = value;
  while (/[.,;!?]$/.test(next)) next = next.slice(0, -1);
  while (hasUnmatchedClosingPunctuation(next)) next = next.slice(0, -1);
  return next;
}

function hasUnmatchedClosingPunctuation(value: string): boolean {
  const last = value.at(-1);
  if (!last || !")]}".includes(last)) return false;
  const open = last === ")" ? "(" : last === "]" ? "[" : "{";
  let balance = 0;
  for (const char of value) {
    if (char === open) balance += 1;
    if (char === last) balance -= 1;
  }
  return balance < 0;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeRepoPart(value: string): string {
  return stripGitSuffix(decodePathSegment(value.trim()));
}

function repoLinkFromParts(input: {
  end: number;
  host: string;
  owner: string | undefined;
  repo: string | undefined;
  start: number;
  url: string;
}): ComposerRepoLink | null {
  const host = input.host.toLowerCase().replace(/^www\./, "");
  const provider = repoProviderForHost(host);
  if (!provider) return null;

  const owner = decodePathSegment(input.owner?.trim() ?? "");
  const repo = normalizeRepoPart(input.repo ?? "");
  if (!owner || !repo) return null;
  if (reservedOwnersForProvider(provider).has(owner.toLowerCase())) return null;

  return {
    end: input.end,
    host,
    label: `${owner}/${repo}`,
    provider,
    repo,
    start: input.start,
    url: input.url,
    owner,
  };
}

function parseWebRepoUrl(raw: string, start: number): ComposerRepoLink | null {
  const url = trimTrailingUrlPunctuation(raw);
  if (!url) return null;

  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return repoLinkFromParts({
      end: start + url.length,
      host: parsed.hostname,
      owner: segments[0],
      repo: segments[1],
      start,
      url,
    });
  } catch {
    return null;
  }
}

function parseScpRepoUrl(raw: string, start: number): ComposerRepoLink | null {
  const url = trimTrailingUrlPunctuation(raw);
  const match = /^(?:git@)?([^:]+):(.+)$/i.exec(url);
  if (!match) return null;
  const host = match[1]?.trim() ?? "";
  const segments = (match[2] ?? "").split("/").filter(Boolean);
  return repoLinkFromParts({
    end: start + url.length,
    host,
    owner: segments[0],
    repo: segments[1],
    start,
    url,
  });
}

function collectRepoLinks(
  content: string,
  pattern: RegExp,
  parse: (raw: string, start: number) => ComposerRepoLink | null,
): ComposerRepoLink[] {
  const matches: ComposerRepoLink[] = [];
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const raw = match[0] ?? "";
    const link = parse(raw, match.index);
    if (link) matches.push(link);
  }

  return matches;
}

export function detectComposerRepoLinks(content: string): ComposerRepoLink[] {
  if (!content) return [];
  const links = [
    ...collectRepoLinks(content, WEB_REPO_URL_PATTERN, parseWebRepoUrl),
    ...collectRepoLinks(content, SCP_REPO_URL_PATTERN, parseScpRepoUrl),
  ].sort((left, right) => left.start - right.start || right.end - left.end);

  const selected: ComposerRepoLink[] = [];
  for (const link of links) {
    if (selected.some((existing) => link.start < existing.end && link.end > existing.start)) continue;
    selected.push(link);
  }
  return selected.sort((left, right) => left.start - right.start);
}
