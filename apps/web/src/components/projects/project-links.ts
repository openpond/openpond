import type { SidebarProjectItem } from "../../lib/app-models";
import { buildCloudProjectUrl } from "../../lib/cloud-environment-setup";

type CloudProjectItem = Extract<SidebarProjectItem, { kind: "cloud" }>;

export function cloudProjectRepositoryUrl(
  project: CloudProjectItem,
  accountBaseUrl: string | null,
): string | null {
  const sourceLabel = project.project.sourceLabel?.trim() ?? "";
  if (project.project.sourceType === "github_repo" && sourceLabel) {
    if (/^https?:\/\//i.test(sourceLabel)) return sourceLabel;
    if (/^[^/\s]+\/[^/\s]+$/.test(sourceLabel)) {
      return `https://github.com/${sourceLabel}`;
    }
  }
  return buildCloudProjectUrl({
    accountBaseUrl,
    organizationSlug: project.project.organizationSlug,
    projectSlug: project.project.slug,
  });
}

export function projectRepositoryUrl(
  project: SidebarProjectItem,
  accountBaseUrl: string | null,
): string | null {
  if (project.kind === "cloud") {
    return cloudProjectRepositoryUrl(project, accountBaseUrl);
  }
  return project.project.linkedSandboxProject?.sourceRepoUrl ?? null;
}

export function displayRepositoryUrl(href: string): string {
  return href.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export async function openProjectUrl(href: string): Promise<void> {
  const browser = window.openpond?.browser;
  if (browser) {
    const result = await browser.openExternal({ conversationId: "projects", url: href });
    if (!result.ok) throw new Error(result.error ?? "Unable to open project URL.");
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
