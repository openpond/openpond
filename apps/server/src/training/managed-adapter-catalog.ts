import { z } from "zod";
import { createHash } from "node:crypto";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";
import { createManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";

const ModelSchema = z.object({
  id: z.string().min(1),
  metadata: z.object({
    artifact_id: z.string().min(1),
    artifact_label: z.string(),
    base_profile_id: z.string().min(1),
    deployment_state: z.string(),
  }),
});
export type ManagedCatalogModel = z.infer<typeof ModelSchema> & { logicalModelName: string | null };

const catalogCache = new Map<string, { until: number; value: Promise<ManagedCatalogModel[]> }>();

/** Catalog reads never provision compute. The gateway owns current access and availability. */
export async function readManagedModelCatalog(
  teamId: string,
  options: { fresh?: boolean } = {},
): Promise<ManagedCatalogModel[]> {
  const access = await resolveManagedAdapterUserAccess({ teamId });
  const key = `${access.apiBaseUrl}:${teamId}:${createHash("sha256").update(access.token).digest("hex")}`;
  const cached = catalogCache.get(key);
  if (!options.fresh && cached && cached.until > Date.now()) return cached.value;
  const value = fetchManagedModelCatalog(access);
  const entry = { until: Date.now() + 15_000, value };
  catalogCache.set(key, entry);
  if (catalogCache.size > 32) catalogCache.delete(catalogCache.keys().next().value!);
  try {
    return await value;
  } catch (error) {
    if (catalogCache.get(key) === entry) catalogCache.delete(key);
    throw error;
  }
}

async function fetchManagedModelCatalog(
  access: Awaited<ReturnType<typeof resolveManagedAdapterUserAccess>>,
): Promise<ManagedCatalogModel[]> {
  const { teamId } = access;
  const headers = hostedApiAuthHeaders(access.token);
  headers.set("x-openpond-team-id", teamId);
  const modelsRequest = fetch(`${access.apiBaseUrl}/v1/models`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const [response, registry] = await Promise.all([
    modelsRequest,
    createManagedAdapterRegistryClient({
      resolveRegistryAccess: async () => access,
      fetchImpl: (url, init) =>
        fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }),
    }).listRegistry(teamId),
  ]);
  if (!response.ok) throw new Error(`Managed model catalog unavailable (${response.status}).`);
  const bindings = z.object({ data: z.array(ModelSchema) }).parse(await response.json()).data;
  const models = new Map<string, ManagedCatalogModel>();
  for (const model of bindings) {
    if (!models.has(model.metadata.artifact_id))
      models.set(model.metadata.artifact_id, {
        ...model,
        id: model.metadata.artifact_id,
        logicalModelName: model.id,
      });
  }
  for (const artifact of registry.artifacts) {
    if (
      ["deleted", "rejected"].includes(artifact.state) ||
      models.has(artifact.id) ||
      !artifact.baseProfileId
    )
      continue;
    models.set(artifact.id, {
      id: artifact.id,
      logicalModelName: null,
      metadata: {
        artifact_id: artifact.id,
        artifact_label: artifact.label || artifact.id,
        base_profile_id: artifact.baseProfileId,
        deployment_state: "unavailable",
      },
    });
  }
  return [...models.values()];
}

export function managedCatalogModelId(teamId: string, artifactId: string): string {
  return `managed:${teamId}:${encodeURIComponent(artifactId)}`;
}

export function managedCatalogSelection(modelId: string | null | undefined) {
  if (!modelId?.startsWith("managed:")) return null;
  const [, teamId, encodedName, extra] = modelId.split(":");
  if (!teamId || !encodedName || extra !== undefined)
    throw new Error("Invalid managed model selection.");
  const artifactId = decodeURIComponent(encodedName);
  if (!artifactId.trim()) throw new Error("Invalid managed model selection.");
  return { teamId, artifactId };
}
