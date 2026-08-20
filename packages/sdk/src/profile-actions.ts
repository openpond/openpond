import { apiFetch, readApiJson } from "@openpond/cloud/api/core";

export type OpenPondProfileActionSetupRequirement = {
  kind: string;
  key: string;
  label: string | null;
  required: boolean;
  status: string;
  warning: string | null;
};

export type OpenPondProfileActionCatalogEntry = {
  /** Stable action key. This is the only action selector accepted by follow-up invocation APIs. */
  key: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  actionId: string;
  actionLabel: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invokesModel: boolean;
  approvalPolicy: {
    required: boolean;
    risk: "read" | "write" | "destructive";
  };
  setupStatus: "ready" | "setup_required";
  setupRequirements: OpenPondProfileActionSetupRequirement[];
  requiredCapabilities: string[];
};

export type OpenPondProfileActionCatalog = {
  profileId: string;
  profileName: string;
  /** Opaque source/action contract version used to reject catalog drift at invocation time. */
  catalogVersion: string;
  sourceCommitSha: string | null;
  actions: OpenPondProfileActionCatalogEntry[];
};

export type OpenPondProfileActionInvocation<TOutput = Record<string, unknown>> = {
  run: {
    id: string;
    status: string;
    conversationId: string | null;
    resultJson: TOutput | null;
  };
};

/** A short-lived capability granted by the calling product for one Profile Action run. */
export type OpenPondExternalCapabilityLease = {
  provider: string;
  capabilities: string[];
  proxyUrl: string;
  bearerToken: string;
  expiresAt?: string;
  resourcePolicy?: Record<string, unknown>;
};

type ProfileActionsClientInput = {
  apiKey: string;
  apiBaseUrl: string;
};

export class OpenPondProfileActionsClient {
  readonly #apiKey: string;
  readonly #apiBaseUrl: string;

  constructor(input: ProfileActionsClientInput) {
    this.#apiKey = input.apiKey;
    this.#apiBaseUrl = input.apiBaseUrl.replace(/\/+$/, "");
  }

  async catalog(input: {
    teamId: string;
    profileId?: string;
    profileName?: string;
  }): Promise<OpenPondProfileActionCatalog> {
    const teamId = requiredValue(input.teamId, "teamId");
    const search = new URLSearchParams({ teamId });
    if (input.profileId?.trim()) search.set("profileId", input.profileId.trim());
    if (input.profileName?.trim()) {
      search.set("profileName", input.profileName.trim());
    }
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      `/v1/profile/actions?${search.toString()}`,
    );
    return (
      await readApiJson<{ catalog: OpenPondProfileActionCatalog }>(
        response,
        "Get Profile Action catalog",
      )
    ).catalog;
  }

  async run<TOutput = Record<string, unknown>>(input: {
    teamId: string;
    actionKey: string;
    profileId?: string;
    profileName?: string;
    value?: Record<string, unknown>;
    conversationId?: string | null;
    createConversation?: boolean;
    conversationTitle?: string | null;
    idempotencyKey: string;
    catalogVersion: string;
    externalCapabilityLeases?: OpenPondExternalCapabilityLease[];
  }): Promise<OpenPondProfileActionInvocation<TOutput>> {
    const teamId = requiredValue(input.teamId, "teamId");
    const actionKey = requiredValue(input.actionKey, "actionKey");
    const idempotencyKey = requiredValue(input.idempotencyKey, "idempotencyKey");
    const catalogVersion = requiredValue(input.catalogVersion, "catalogVersion");
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      `/v1/profile/actions/run?${new URLSearchParams({ teamId }).toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(input.profileId?.trim() ? { profileId: input.profileId.trim() } : {}),
          ...(input.profileName?.trim() ? { profileName: input.profileName.trim() } : {}),
          actionKey,
          value: input.value ?? {},
          conversationId: input.conversationId ?? null,
          createConversation: input.createConversation,
          conversationTitle: input.conversationTitle ?? null,
          idempotencyKey,
          catalogVersion,
          externalCapabilityLeases: input.externalCapabilityLeases,
        }),
      },
    );
    return readApiJson<OpenPondProfileActionInvocation<TOutput>>(
      response,
      "Run Profile Action",
    );
  }
}

function requiredValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
