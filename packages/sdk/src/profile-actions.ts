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
}

function requiredValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
