import { useQuery } from "@tanstack/react-query";
import { parseAndVerifyModelModificationCapabilities, type ModelModificationCapabilities, type ModelModificationCapabilitiesQuery, type ActivationExperimentFormDraft } from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

/** A new model/account gets a new observation. Discovery creates no execution
 * and its expiry is checked again by any future preparation owner. */
export function useModelModificationCapabilities(api: WorkspaceApi, model: ActivationExperimentFormDraft["baseModel"], enabled: boolean) {
  const query: ModelModificationCapabilitiesQuery | null = model ? { teamId: api.teamId, modelId: model.modelId, source: model.source,
    ...(model.revision ? { revision: model.revision } : {}), ...(model.tokenizerRevision ? { tokenizerRevision: model.tokenizerRevision } : {}),
    ...(model.chatTemplateHash ? { chatTemplateHash: model.chatTemplateHash } : {}), ...(model.modelAssetId ? { modelAssetId: model.modelAssetId } : {}),
  } : null;
  const result = useQuery<ModelModificationCapabilities>({ queryKey: ["model-modification-capabilities", api.key, api.actorId, query],
    enabled: enabled && query !== null, retry: false, staleTime: 30_000,
    refetchInterval: state => state.state.error ? false : 60_000,
    queryFn: async ({ signal }) => {
      if (!query) throw new Error("Select a starting model before reading capabilities.");
      return parseAndVerifyModelModificationCapabilities(await apiFetch(api.connection,
        `/v1/training/setup/modification-capabilities?teamId=${encodeURIComponent(api.teamId)}`,
        { method: "POST", body: JSON.stringify(query), signal }), query, api.actorId ?? undefined);
    },
  });
  const fresh = Boolean(result.data && Date.parse(result.data.expiresAt) > Date.now());
  return { ...result, current: fresh ? result.data : undefined, canRefresh: Boolean(query) };
}
