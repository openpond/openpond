import type { ModelStarterCreationRequest } from "openpond-sdk/model-starters";
import { parseModelStarterCreationRequest, previewModelStarter, validateResolvedModelStarter } from "openpond-sdk/model-starters";
import type { ModelStarterCommitInput } from "../store/store-model-starters.js";
import type { SqliteStore } from "../store/store.js";
import { materializeModelStarterPackage } from "./model-starter-package-files.js";
import { prepareModelStarterTaskset } from "./model-starter-taskset.js";

export interface LocalModelStarterCatalog {
  /** Resolve only trusted, pinned catalog publications. Never caller uploads. */
  resolve(reference: ModelStarterCreationRequest["starter"], profileId: string): Promise<Omit<ModelStarterCommitInput, "request" | "createdAt">>;
}

export function createModelStarterCreationService(input: { store: SqliteStore; home: string; catalog: LocalModelStarterCatalog; now?: () => string }) {
  return {
    async preview(reference: ModelStarterCreationRequest["starter"], profileId: string) {
      const publication = await input.catalog.resolve(reference, profileId);
      const resolved = validateResolvedModelStarter(publication.package);
      if (resolved.starter.id !== reference.id || resolved.starter.revision !== reference.revision || resolved.starter.contentHash !== reference.contentHash) throw new Error("Catalog returned a different starter revision.");
      return previewModelStarter(resolved);
    },
    async create(raw: unknown, authorizedProfileId: string) {
      const request = parseModelStarterCreationRequest(raw);
      if (request.profileId !== authorizedProfileId) throw new Error("Starter creation is outside the authorized Profile.");
      const previous = await input.store.findModelStarterCreation(request);
      if (previous) return previous;
      const publication = await input.catalog.resolve(request.starter, authorizedProfileId);
      const commit = { ...publication, request, createdAt: input.now?.() ?? new Date().toISOString() };
      const prepared = prepareModelStarterTaskset(commit);
      await materializeModelStarterPackage(input.home, prepared);
      return input.store.saveModelStarterCreation(commit);
    },
  };
}
