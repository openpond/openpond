import type { CloudProject, LocalProject } from "@openpond/contracts";

export type LocalProjectCloudLinkTrustState = "none" | "confirmed" | "different_account";

export type LocalProjectCloudLinkTrust = {
  state: LocalProjectCloudLinkTrustState;
  linked: NonNullable<LocalProject["linkedSandboxProject"]> | null;
  cloudProject: CloudProject | null;
};

export const DIFFERENT_ACCOUNT_CLOUD_LINK_LABEL = "uploaded to a different account";

export function localProjectCloudLinkTrust(
  project: LocalProject | null | undefined,
  cloudProjects: CloudProject[] | null | undefined,
): LocalProjectCloudLinkTrust {
  const linked = project?.linkedSandboxProject ?? null;
  if (!linked?.projectId || !linked.teamId) {
    return { state: "none", linked: null, cloudProject: null };
  }

  const cloudProject =
    cloudProjects?.find((candidate) => candidate.id === linked.projectId && candidate.teamId === linked.teamId) ??
    null;
  if (!cloudProject) {
    return { state: "different_account", linked, cloudProject: null };
  }

  return { state: "confirmed", linked, cloudProject };
}

export function confirmedLinkedCloudProject(
  project: LocalProject | null | undefined,
  cloudProjects: CloudProject[] | null | undefined,
): CloudProject | null {
  const trust = localProjectCloudLinkTrust(project, cloudProjects);
  return trust.state === "confirmed" ? trust.cloudProject : null;
}

export function localProjectCloudLinkWarning(
  project: LocalProject | null | undefined,
  cloudProjects: CloudProject[] | null | undefined,
): string | null {
  return localProjectCloudLinkTrust(project, cloudProjects).state === "different_account"
    ? DIFFERENT_ACCOUNT_CLOUD_LINK_LABEL
    : null;
}
