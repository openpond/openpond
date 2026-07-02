export type RepoTarget = { handle: string; repo: string };

export function resolveRepoUrl(response: {
  repoUrl?: string | null;
  gitHost?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
}): string {
  if (response.repoUrl) return response.repoUrl;
  if (response.gitHost && response.gitOwner && response.gitRepo) {
    return `https://${response.gitHost}/${response.gitOwner}/${response.gitRepo}.git`;
  }
  throw new Error("repoUrl missing from API response");
}

export function formatTokenizedRepoUrl(repoUrl: string, token: string): string {
  const url = new URL(repoUrl);
  const encodedToken = encodeURIComponent(token);
  return `${url.protocol}//x-access-token:${encodedToken}@${url.host}${url.pathname}`;
}

export function formatTokenizedRepoUrlForPrint(repoUrl: string): string {
  const url = new URL(repoUrl);
  return `${url.protocol}//x-access-token:$OPENPOND_API_KEY@${url.host}${url.pathname}`;
}

export function redactToken(value: string): string {
  return value.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

export function warnOnRepoHostMismatch(repoUrl: string): void {
  const envBase = process.env.OPENPOND_BASE_URL;
  if (!envBase) return;
  try {
    const baseHost = new URL(envBase).hostname;
    const repoHost = new URL(repoUrl).hostname;
    if (baseHost && repoHost && baseHost !== repoHost) {
      console.warn(
        `warning: repo host (${repoHost}) does not match OPENPOND_BASE_URL (${baseHost})`
      );
      console.warn(
        "warning: verify your git host configuration matches OPENPOND_BASE_URL."
      );
    }
  } catch {
    // ignore malformed env base or repo URL
  }
}

export function parseHandleRepo(value: string): RepoTarget {
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("expected <handle>/<repo>");
  }
  return { handle: parts[0]!, repo: parts[1]! };
}

export function normalizeRepoName(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}
