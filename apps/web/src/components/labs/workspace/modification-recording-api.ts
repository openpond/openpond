import { canonicalJson, canonicalSha256, verifyModificationRecording, verifyModificationRecordingRead, verifyModificationRecordingRequest,
  ModificationRecordingPageSchema, type ModificationRecordingRequest, type ModificationRecordingListQuery } from "openpond-sdk/training";
import { apiFetch } from "../../../api/api-client";
import type { WorkspaceApi } from "./workspace-api";

/** Local custody is explicit. This transport cannot turn an external capture
 * into a hosted execution or a managed measurement receipt. */
export function modificationRecordingApi(api: WorkspaceApi, signal?: AbortSignal) {
  const endpoint = (path = "", params: Record<string, string> = {}) => `/v1/modification-recordings${path}?${new URLSearchParams({ teamId: api.teamId, ...params })}`;
  return {
    async record(raw: ModificationRecordingRequest) {
      const command = await verifyModificationRecordingRequest(raw);
      if (command.teamId !== api.teamId) throw new Error("The observation belongs to another workspace.");
      const value = await verifyModificationRecording(await apiFetch(api.connection, "/v1/modification-recordings", {
        method: "POST", body: canonicalJson(command), signal }), api.teamId, api.actorId ?? undefined);
      if (value.operationId !== command.operationId || value.commandHash !== await canonicalSha256(command)) throw new Error("The observation operation changed.");
      return value;
    },
    async read(id: string) {
      const value = await verifyModificationRecordingRead(await apiFetch(api.connection, endpoint(`/${encodeURIComponent(id)}`), { signal }), api.teamId, api.actorId ?? undefined);
      if (value.recording.id !== id || api.projectId && value.recording.projectId !== api.projectId) throw new Error("The service returned another observation or Project.");
      return value;
    },
    async list(query: Omit<ModificationRecordingListQuery, "teamId" | "projectId"> = {}) {
      const page = ModificationRecordingPageSchema.parse(await apiFetch(api.connection, endpoint("", {
        ...(api.projectId ? { projectId: api.projectId } : {}), ...Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])),
      }), { signal }));
      if (page.teamId !== api.teamId || page.actorId !== api.actorId || page.projectId !== (api.projectId ?? null)
        || page.items.length > (query.limit ?? 30) || query.cursor && page.nextCursor === query.cursor || new Set(page.items.map(row => row.id)).size !== page.items.length)
        throw new Error("Observations returned another account, Project or page.");
      for (const row of page.items) {
        await verifyModificationRecording(row, api.teamId, api.actorId ?? undefined);
        if (row.accountScopeHash !== page.accountScopeHash || api.projectId && row.projectId !== api.projectId) throw new Error("Observation scope changed.");
      }
      return page;
    },
  };
}
