import { createExperimentDraftClient, type ExperimentDraftRecord } from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

/** The Desktop transport delegates to the same hosted SDK owner. No renderer
 * credentials, alternate storage or execution-location-specific draft copies. */
export function experimentDraftApi(api: WorkspaceApi, signal?: AbortSignal) {
  const client = createExperimentDraftClient((path, init) => {
    const [pathname, search] = path.split("?");
    const query = new URLSearchParams(search);
    query.set("teamId", api.teamId);
    return apiFetch(api.connection,
      `${pathname!.replace("/v1/training/experiment-drafts", "/v1/training/setup/drafts")}?${query}`,
      { ...init, signal });
  });
  function owner(record: ExperimentDraftRecord) {
    if (!api.actorId || record.ownerUserId !== api.actorId || record.teamId !== api.teamId ||
        api.projectId && record.projectId !== api.projectId)
      throw new Error("The saved experiment belongs to another account or Project.");
    return record;
  }
  return {
    async get(id: string) { return owner(await client.getExperimentDraft(api.teamId, id)); },
    async list(filters: { search?: string; cursor?: string } = {}) {
      const page = await client.listExperimentDrafts(api.teamId, {
        ...filters, ...(api.projectId ? { projectId: api.projectId } : {}), limit: 30,
      });
      if (!api.actorId || page.ownerUserId !== api.actorId)
        throw new Error("The saved experiment list belongs to another account.");
      page.items.forEach(owner);
      return page;
    },
    async save(input: Parameters<typeof client.saveExperimentDraft>[0]) {
      const receipt = await client.saveExperimentDraft(input);
      owner(receipt.record);
      return receipt;
    },
  };
}
