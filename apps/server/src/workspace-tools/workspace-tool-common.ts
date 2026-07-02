export type FileReadResult = {
  path: string;
  content: string;
};

export type CheckResult = {
  ok: boolean;
  command: string;
  code: number;
  stdout: string;
  stderr: string;
};

export type GitStatusFile = {
  path: string;
  status: string;
};

export type GitStatusResult = {
  branch: string | null;
  upstream: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  diverged: boolean;
  lastFetchAt: string | null;
  dirty: boolean;
  files: GitStatusFile[];
};

export type WorkspacePreviewFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "unchanged";
  additions: number;
  deletions: number;
  patch: string;
};

export type WorkspacePreview = {
  filesChanged: number;
  additions: number;
  deletions: number;
  files: WorkspacePreviewFile[];
};

export type DeploymentSource = {
  branch: string;
  commitSha: string;
  upstream: string;
  remoteUrl: string;
};

export const MAX_READ_CHARS = 120000;
export const MAX_CHECK_OUTPUT_CHARS = 60000;
export const MAX_PREVIEW_PATCH_CHARS = 24000;

export function trimOutput(value: string): string {
  if (value.length <= MAX_CHECK_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_CHECK_OUTPUT_CHARS)}\n\n[output truncated]`;
}

export function redactRemoteUrl(value: string): string {
  return value
    .replace(/x-access-token:[^@]+@/g, "x-access-token:***@")
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic ***");
}

export function truncatePatch(value: string): string {
  if (value.length <= MAX_PREVIEW_PATCH_CHARS) return value;
  return `${value.slice(0, MAX_PREVIEW_PATCH_CHARS)}\n\n[diff truncated]`;
}

function isOpenPondRemote(remoteUrl: string): boolean {
  try {
    const host = new URL(remoteUrl).hostname.toLowerCase();
    return host === "openpond.ai" || host.endsWith(".openpond.ai");
  } catch {
    return false;
  }
}

export function gitBasicAuthEnv(remoteUrl: string, token?: string | null): NodeJS.ProcessEnv {
  if (!token || !isOpenPondRemote(remoteUrl)) return {};
  const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
  };
}
