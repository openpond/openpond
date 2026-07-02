export type MicrosoftTeamsBotBinding = {
  id: string;
  installationId: string;
  tenantId: string;
  teamsTeamId: string | null;
  teamsChannelId: string | null;
  conversationId: string;
  threadRootActivityId: string | null;
  openpondTeamId: string;
  sandboxId: string | null;
  projectId: string | null;
  agentId: string | null;
  defaultRoute: string;
  createdByUserId: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MicrosoftTeamsBotOverview = {
  teamsBotTablesReady: boolean;
  teamId: string;
  role: string;
  canManage: boolean;
  bindings: MicrosoftTeamsBotBinding[];
  installations: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
  entitlement: Record<string, unknown>;
  config: Record<string, unknown>;
};

export type MicrosoftTeamsBotBindingTargetInput = {
  teamId: string;
  sandboxId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  microsoftConnectionId?: string | null;
};

export type MicrosoftTeamsBotBindingResponse = {
  binding: MicrosoftTeamsBotBinding;
};

export type MicrosoftTeamsBotDiagnosticRunInput = {
  teamId: string;
  bindingId: string;
  prompt: string;
  attachments?: Array<Record<string, unknown>>;
  actionInput?: Record<string, unknown>;
};

export type MicrosoftTeamsBotDiagnosticRunResponse =
  MicrosoftTeamsBotBindingResponse & {
    diagnosticRunStatus: string;
    route: Record<string, unknown>;
  };
