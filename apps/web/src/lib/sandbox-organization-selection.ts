import { normalizeSandboxOrganizationTeamId } from "./sandbox-organization-url";
import type { OpenPondOrganization } from "./organization-types";

export function resolveSandboxOrganizationSlug(params: {
  currentSlug: string | null | undefined;
  organizations: OpenPondOrganization[];
  urlTeamId: string | null | undefined;
}): string {
  const currentSlug = params.currentSlug?.trim() ?? "";
  if (currentSlug) {
    return params.organizations.some(
      (organization) => organization.slug === currentSlug,
    )
      ? currentSlug
      : "";
  }

  const urlTeamId = normalizeSandboxOrganizationTeamId(params.urlTeamId);
  if (urlTeamId) {
    return (
      params.organizations.find(
        (organization) => organization.teamId === urlTeamId,
      )?.slug ?? ""
    );
  }

  return params.organizations.length === 1
    ? (params.organizations[0]?.slug ?? "")
    : "";
}
