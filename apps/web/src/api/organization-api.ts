import type {
  CreateOpenPondOrganizationRequest,
  GenerateOpenPondOrganizationMcpServerRequest,
  OpenPondOrganizationMemberResponse,
  OpenPondOrganizationMembersResponse,
  OpenPondOrganizationMcpServerResponse,
  OpenPondOrganizationResponse,
  OpenPondOrganizationsResponse,
  OpenPondTeamInvitationResponse,
  OpenPondTeamInvitationsResponse,
  UpdateOpenPondOrganizationRequest,
  UpsertOpenPondOrganizationMemberRequest,
} from "../lib/organization-types";
import { apiFetch, type ClientConnection } from "./api-client";

export const organizationApi = {
  teamInvitations: (connection: ClientConnection) =>
    apiFetch<OpenPondTeamInvitationsResponse>(connection, "/v1/team-invitations"),
  decideTeamInvitation: (connection: ClientConnection, decision: "accept" | "decline", token: string) =>
    apiFetch<OpenPondTeamInvitationResponse>(connection, `/v1/team-invitations/${decision}`, {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  organizations: (connection: ClientConnection) =>
    apiFetch<OpenPondOrganizationsResponse>(connection, "/v1/organizations"),
  createOrganization: (connection: ClientConnection, input: CreateOpenPondOrganizationRequest) =>
    apiFetch<OpenPondOrganizationResponse>(connection, "/v1/organizations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateOrganization: (connection: ClientConnection, slug: string, input: UpdateOpenPondOrganizationRequest) =>
    apiFetch<OpenPondOrganizationResponse>(connection, `/v1/organizations/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  organizationMembers: (connection: ClientConnection, slug: string) =>
    apiFetch<OpenPondOrganizationMembersResponse>(connection, `/v1/organizations/${encodeURIComponent(slug)}/members`),
  upsertOrganizationMember: (
    connection: ClientConnection,
    slug: string,
    input: UpsertOpenPondOrganizationMemberRequest
  ) =>
    apiFetch<OpenPondOrganizationMemberResponse>(connection, `/v1/organizations/${encodeURIComponent(slug)}/members`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  organizationMcpServer: (connection: ClientConnection, slug: string) =>
    apiFetch<OpenPondOrganizationMcpServerResponse>(
      connection,
      `/v1/organizations/${encodeURIComponent(slug)}/mcp-server`
    ),
  generateOrganizationMcpServer: (
    connection: ClientConnection,
    slug: string,
    input: GenerateOpenPondOrganizationMcpServerRequest
  ) =>
    apiFetch<OpenPondOrganizationMcpServerResponse>(
      connection,
      `/v1/organizations/${encodeURIComponent(slug)}/mcp-server`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ),
  setOrganizationMcpServerStatus: (
    connection: ClientConnection,
    slug: string,
    action: "rotate" | "disable" | "enable"
  ) =>
    apiFetch<OpenPondOrganizationMcpServerResponse>(
      connection,
      `/v1/organizations/${encodeURIComponent(slug)}/mcp-server/${action}`,
      {
        method: "POST",
      }
    ),
};
