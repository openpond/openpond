import { chatCatalogFetch } from "./chat-catalog-fetch.js";
import { createTrainingClient, ExperimentDraftSaveSchema, type ExperimentDraftRecord } from "openpond-sdk/training";
import type { ChatContextSelection, StoredExperimentDraftReference } from "@openpond/contracts";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

export type ChatDraftAccess = { apiBaseUrl: string; token: string; teamId: string; actorId: string };
export function storedDraftSelection(record: ExperimentDraftRecord, reference: StoredExperimentDraftReference): ChatContextSelection {
  return { target: { kind: "experiment", id: reference.id, location: "cloud", storedDraft: true,
    teamId: reference.teamId, apiOrigin: reference.apiOrigin }, draft: record.draft, storedDraft: record,
    draftRevision: record.revision, label: record.draft.name, detail: "Saved experiment draft" };
}
export function createChatExperimentDraftStorage(access: () => Promise<ChatDraftAccess>) {
  async function client() {
    const current = { ...await access() };
    const referenceScope = { teamId: current.teamId, apiOrigin: new URL(current.apiBaseUrl).origin };
    const headers = hostedApiAuthHeaders(current.token); headers.set("x-openpond-team-id", current.teamId);
    const training = createTrainingClient({ baseUrl: current.apiBaseUrl, headers, fetch: chatCatalogFetch });
    async function fence(record?: ExperimentDraftRecord) {
      const active = await access();
      if (active.teamId !== current.teamId || active.actorId !== current.actorId ||
          new URL(active.apiBaseUrl).origin !== referenceScope.apiOrigin)
        throw new Error("The active account changed while reading the experiment draft.");
      if (record && (record.teamId !== current.teamId || record.ownerUserId !== current.actorId))
        throw new Error("This experiment draft belongs to another account.");
    }
    return { current, referenceScope, training, fence };
  }
  return {
    async read(reference: StoredExperimentDraftReference) {
      const owner = await client();
      if (reference.teamId !== owner.current.teamId || reference.apiOrigin !== owner.referenceScope.apiOrigin)
        throw new Error("This experiment draft belongs to another workspace or API.");
      const record = await owner.training.getExperimentDraft(reference.teamId, reference.id);
      await owner.fence(record);
      if (record.status !== "draft") throw new Error("This experiment draft is archived. Reopen it in Experiments to restore it.");
      return record;
    },
    async save(raw: unknown) {
      const input = ExperimentDraftSaveSchema.parse(raw), owner = await client();
      if (input.teamId !== owner.current.teamId) throw new Error("The experiment workspace changed.");
      const receipt = await owner.training.saveExperimentDraft(input);
      await owner.fence(receipt.record);
      return { receipt, reference: { id: receipt.record.id, ...owner.referenceScope } };
    },
    async list(cursor?: string) {
      const owner = await client();
      const page = await owner.training.listExperimentDrafts(owner.current.teamId, { limit: 30, ...(cursor ? { cursor } : {}) });
      await owner.fence();
      if (page.ownerUserId !== owner.current.actorId) throw new Error("Draft history returned another owner.");
      return { page, options: page.items.map(record => storedDraftSelection(record, { id: record.id, ...owner.referenceScope })) };
    },
  };
}
