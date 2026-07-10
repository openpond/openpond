export type OpenPondOrganizationRole = "owner" | "admin" | "member";

export type OpenPondOrganizationStatus = "active" | "disabled" | "archived";

export type OpenPondOrganization = {
  teamId: string;
  slug: string;
  name: string;
  displayName: string;
  role: OpenPondOrganizationRole;
  workspaceKind?: "personal" | "shared";
  status: OpenPondOrganizationStatus;
  kind?: "personal_default" | "managed_client" | "team";
  isPersonalDefault?: boolean;
  isManagedClient?: boolean;
  primaryContactEmail: string | null;
  customDomain: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpenPondOrganizationMcpServerStatus = "active" | "disabled" | "rotating";

export type OpenPondOrganizationMcpServer = {
  id: string;
  teamId: string;
  slug: string;
  displayName: string;
  resourceUrl: string;
  transportUrl: string;
  toolset: string[];
  status: OpenPondOrganizationMcpServerStatus;
  generatedByUserId: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpenPondOrganizationMember = {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  role: OpenPondOrganizationRole;
  createdAt: string;
};

export type OpenPondTeamInvitation = {
  id: string;
  teamId: string;
  email: string;
  role: "admin" | "member";
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
};

export type OpenPondTeamInvitationsResponse = {
  invitations: OpenPondTeamInvitation[];
};

export type OpenPondTeamInvitationResponse = {
  invitation: OpenPondTeamInvitation;
};

export type OpenPondOrganizationsResponse = {
  organizations: OpenPondOrganization[];
};

export type OpenPondOrganizationResponse = {
  organization: OpenPondOrganization;
};

export type OpenPondOrganizationMcpServerResponse = {
  mcpServer: OpenPondOrganizationMcpServer | null;
};

export type OpenPondOrganizationMembersResponse = {
  members: OpenPondOrganizationMember[];
};

export type OpenPondOrganizationMemberResponse = {
  member: OpenPondOrganizationMember;
};

export type CreateOpenPondOrganizationRequest = {
  displayName: string;
  slug?: string | null;
  primaryContactEmail?: string | null;
  customDomain?: string | null;
};

export type UpdateOpenPondOrganizationRequest = Partial<CreateOpenPondOrganizationRequest> & {
  status?: OpenPondOrganizationStatus;
};

export type GenerateOpenPondOrganizationMcpServerRequest = {
  origin?: string | null;
  toolset?: string[] | null;
};

export type UpsertOpenPondOrganizationMemberRequest = {
  email: string;
  role: OpenPondOrganizationRole;
};

export function openPondOrganizationRoleLabel(role: OpenPondOrganizationRole | null | undefined): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  return "Member";
}

export function openPondOrganizationContextLabel(organization: OpenPondOrganization | null | undefined): string | null {
  if (!organization) return null;
  return `${organization.displayName} · ${openPondOrganizationRoleLabel(organization.role)}`;
}

export function canManageOpenPondOrganization(organization: OpenPondOrganization | null | undefined): boolean {
  return organization?.role === "owner" || organization?.role === "admin";
}
