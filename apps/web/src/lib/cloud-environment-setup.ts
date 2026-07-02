export const CLOUD_CODING_RUNTIME_PROFILE_ID = "openpond-coding-core-v1";
export const CLOUD_CODING_WORKFLOW_MODE = "feature";

export type CloudEnvironmentCreateUrlInput = {
  accountBaseUrl?: string | null;
  teamId: string;
  projectId: string;
  projectName?: string | null;
  baseBranch?: string | null;
  localProjectId?: string | null;
  source: "openpond-app";
};

export type CloudProjectUrlInput = {
  accountBaseUrl?: string | null;
  organizationSlug?: string | null;
  projectSlug?: string | null;
};

export type CloudProjectCreateUrlInput = {
  accountBaseUrl?: string | null;
  teamId?: string | null;
  source?: "github" | "template";
};

export function buildCloudEnvironmentCreateUrl(input: CloudEnvironmentCreateUrlInput): string {
  const url = new URL("/sandboxes", normalizeOpenPondWebBaseUrl(input.accountBaseUrl));
  url.searchParams.set("teamId", input.teamId);
  url.searchParams.set("create", "sandbox");
  url.searchParams.set("intent", "cloud-coding");
  url.searchParams.set("source", input.source);
  url.searchParams.set("projectId", input.projectId);
  url.searchParams.set("workflowMode", CLOUD_CODING_WORKFLOW_MODE);
  url.searchParams.set("runtimeProfileId", CLOUD_CODING_RUNTIME_PROFILE_ID);
  if (input.projectName?.trim()) url.searchParams.set("projectName", input.projectName.trim());
  if (input.baseBranch?.trim()) url.searchParams.set("baseBranch", input.baseBranch.trim());
  if (input.localProjectId?.trim()) url.searchParams.set("localProjectId", input.localProjectId.trim());
  return url.toString();
}

export function buildCloudProjectCreateUrl(input: CloudProjectCreateUrlInput): string {
  const url = new URL("/sandboxes/projects", normalizeOpenPondWebBaseUrl(input.accountBaseUrl));
  if (input.teamId?.trim()) url.searchParams.set("teamId", input.teamId.trim());
  if (input.source) {
    url.searchParams.set("create", "project");
    url.searchParams.set("source", input.source);
  }
  return url.toString();
}

export function buildCloudTemplatesUrl(input: Pick<CloudProjectCreateUrlInput, "accountBaseUrl" | "teamId">): string {
  const url = new URL("/sandboxes/templates", normalizeOpenPondWebBaseUrl(input.accountBaseUrl));
  if (input.teamId?.trim()) url.searchParams.set("teamId", input.teamId.trim());
  return url.toString();
}

export function buildCloudProjectUrl(input: CloudProjectUrlInput): string | null {
  const organizationSlug = input.organizationSlug?.trim();
  const projectSlug = input.projectSlug?.trim();
  if (!organizationSlug || !projectSlug) return null;
  const url = new URL(
    `/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(projectSlug)}`,
    normalizeOpenPondWebBaseUrl(input.accountBaseUrl),
  );
  return url.toString();
}

function normalizeOpenPondWebBaseUrl(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return "https://openpond.ai";
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "https://openpond.ai";
  }
}
