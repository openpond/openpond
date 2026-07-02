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
  return {
    teamId,
    slug: raw.slug || slugifyCloudProjectName(displayName),
    name: raw.name || displayName,
    displayName,
    role: raw.role === "owner" || raw.role === "admin" || raw.role === "member" ? raw.role : "member",
    status: raw.status === "disabled" || raw.status === "archived" ? raw.status : "active",
    primaryContactEmail: raw.primaryContactEmail ?? null,
    customDomain: raw.customDomain ?? null,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
  };
}
