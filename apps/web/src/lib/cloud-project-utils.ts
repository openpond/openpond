import type { OpenPondOrganization } from "./organization-types";

export function slugifyCloudProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "cloud-project";
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function normalizeOpenPondOrganization(value: OpenPondOrganization): OpenPondOrganization | null {
  const raw = value as OpenPondOrganization & { id?: string };
  const teamId = raw.teamId || raw.id || "";
  if (!teamId) return null;
  const displayName = raw.displayName || raw.name || teamId;
  const isPersonalDefault =
    raw.workspaceKind === "personal" ||
    raw.isPersonalDefault === true ||
    raw.kind === "personal_default" ||
    raw.name?.trim().toLowerCase() === "personal";
  return {
    teamId,
    slug: raw.slug || slugifyCloudProjectName(displayName),
    name: raw.name || displayName,
    displayName,
    role: raw.role === "owner" || raw.role === "admin" || raw.role === "member" ? raw.role : "member",
    workspaceKind:
      raw.workspaceKind === "personal" || raw.workspaceKind === "shared"
        ? raw.workspaceKind
        : isPersonalDefault
        ? "personal"
        : "shared",
    status: raw.status === "disabled" || raw.status === "archived" ? raw.status : "active",
    kind:
      raw.kind === "personal_default" || raw.kind === "managed_client" || raw.kind === "team" ? raw.kind : undefined,
    isPersonalDefault,
    isManagedClient: raw.isManagedClient === true || raw.kind === "managed_client",
    primaryContactEmail: raw.primaryContactEmail ?? null,
    customDomain: raw.customDomain ?? null,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}

export function resolveDefaultOpenPondOrganization(organizations: OpenPondOrganization[]): OpenPondOrganization | null {
  return (
    organizations.find(
      (organization) =>
        organization.workspaceKind === "personal" ||
        organization.isPersonalDefault === true ||
        organization.kind === "personal_default"
    ) ??
    organizations.find((organization) => organization.name.trim().toLowerCase() === "default") ??
    organizations.find(
      (organization) => organization.isManagedClient !== true && organization.kind !== "managed_client"
    ) ??
    organizations[0] ??
    null
  );
}

export function resolveTeamChatOpenPondOrganization(
  organizations: OpenPondOrganization[],
  preferredTeamId?: string | null,
): OpenPondOrganization | null {
  const sharedOrganizations = organizations.filter(
    (organization) =>
      organization.status === "active" && organization.workspaceKind === "shared",
  );
  const normalizedPreferredTeamId = preferredTeamId?.trim() ?? "";
  if (normalizedPreferredTeamId) {
    const preferred = sharedOrganizations.find(
      (organization) => organization.teamId === normalizedPreferredTeamId,
    );
    if (preferred) return preferred;
  }
  return (
    sharedOrganizations.find((organization) => organization.role === "owner") ??
    sharedOrganizations.find((organization) => organization.role === "admin") ??
    sharedOrganizations[0] ??
    null
  );
}
