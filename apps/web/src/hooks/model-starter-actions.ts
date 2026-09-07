import type { ModelProject } from "@openpond/contracts";
import { ModelProjectConfigurationCheckSchema } from "openpond-sdk/model-projects";
import type { ModelStarter, ModelStarterCreationRequest, previewModelStarter } from "openpond-sdk/model-starters";
import { api, type ClientConnection } from "../api";
import type { ModelStarterCatalogItem } from "openpond-sdk/model-starter-catalog";

export type ModelStarterPreview = ReturnType<typeof previewModelStarter>;
export type ModelStarterPage = { items: ModelStarterCatalogItem[]; nextCursor: string | null };

export function createModelStarterActions(connection: ClientConnection | null, mutate: <T>(key: string, path: string, body: unknown) => Promise<T | null>) {
  return {
    listModelStarters: async (afterId?: string, fresh = false) => {
      if (!connection) throw new Error("Connect to OpenPond to browse model starters.");
      return api.trainingRequest<ModelStarterPage>(connection, `/model-starters?limit=30${afterId ? `&afterId=${encodeURIComponent(afterId)}` : ""}${fresh ? "&fresh=true" : ""}`, {}, "GET");
    },
    previewModelStarter: async (starter: ModelStarter) => {
      if (!connection) throw new Error("Connect to OpenPond to preview a starter.");
      return api.trainingRequest<ModelStarterPreview>(connection, "/model-starters/preview", { id: starter.id, revision: starter.revision, contentHash: starter.contentHash });
    },
    checkModelStarter: async (request: ModelStarterCreationRequest) => {
      if (!connection) throw new Error("Connect to OpenPond to check this starter.");
      return ModelProjectConfigurationCheckSchema.parse(await api.trainingRequest(connection, "/model-starters/check", request));
    },
    createModelFromStarter: (request: ModelStarterCreationRequest) => mutate<ModelProject>("create-model-from-starter", "/model-starters/create", request),
  };
}
