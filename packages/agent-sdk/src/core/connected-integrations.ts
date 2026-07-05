import {
  CONNECTED_APP_BUNDLES,
  connectedAppBundleByProvider,
  normalizeConnectedAppProviderFamilyId,
} from "@openpond/connected-apps";

import type { IntegrationDefinition } from "../index";

export type ConnectedIntegrationProvider =
  | "google"
  | "github"
  | "x";

export type ConnectedIntegrationCatalogEntry = {
  provider: ConnectedIntegrationProvider;
  label: string;
  description: string;
  capabilityIds: string[];
  defaultLeaseCapabilityIds: string[];
  defaultTtlSeconds: number | null;
};

export type ConnectedIntegrationDefinition<
  TProvider extends ConnectedIntegrationProvider = ConnectedIntegrationProvider,
> = Omit<IntegrationDefinition, "provider"> & {
  provider: TProvider;
  setupSurface?: "oauth_connector";
};

export const CONNECTED_INTEGRATION_PROVIDERS: ConnectedIntegrationProvider[] = [
  "google",
  "github",
  "x",
];

export function connectedIntegrationCatalog(): ConnectedIntegrationCatalogEntry[] {
  return CONNECTED_APP_BUNDLES
    .filter((bundle) => isConnectedIntegrationProvider(bundle.id))
    .map((bundle) => ({
      provider: bundle.id as ConnectedIntegrationProvider,
      label: bundle.label,
      description: bundle.description,
      capabilityIds: bundle.capabilities
        .filter((capability) => capability.leaseable)
        .map((capability) => capability.id),
      defaultLeaseCapabilityIds: bundle.leasePolicy.allowedCapabilityIds,
      defaultTtlSeconds: bundle.leasePolicy.defaultTtlSeconds,
    }));
}

export function connectedIntegrationCapabilityIds(
  provider: ConnectedIntegrationProvider | string,
): string[] {
  const normalized = normalizeConnectedIntegrationProvider(provider);
  if (!normalized) return [];
  const bundle = connectedAppBundleByProvider(normalized);
  return bundle?.capabilities
    .filter((capability) => capability.leaseable)
    .map((capability) => capability.id) ?? [];
}

export function connectedIntegrationDefaultCapabilityIds(
  provider: ConnectedIntegrationProvider | string,
): string[] {
  const normalized = normalizeConnectedIntegrationProvider(provider);
  if (!normalized) return [];
  return connectedAppBundleByProvider(normalized)?.leasePolicy.allowedCapabilityIds ?? [];
}

export function isConnectedIntegrationProvider(
  provider: string | null | undefined,
): provider is ConnectedIntegrationProvider {
  return normalizeConnectedIntegrationProvider(provider) !== null;
}

export function normalizeConnectedIntegrationProvider(
  provider: string | null | undefined,
): ConnectedIntegrationProvider | null {
  const normalized = normalizeConnectedAppProviderFamilyId(provider);
  if (!normalized || normalized === "mcp") return null;
  return CONNECTED_INTEGRATION_PROVIDERS.includes(normalized as ConnectedIntegrationProvider)
    ? (normalized as ConnectedIntegrationProvider)
    : null;
}

export function defineConnectedIntegration<
  TProvider extends ConnectedIntegrationProvider,
>(
  provider: TProvider,
  definition: Omit<ConnectedIntegrationDefinition<TProvider>, "provider"> = {},
): ConnectedIntegrationDefinition<TProvider> {
  const normalized = normalizeConnectedIntegrationProvider(provider);
  if (!normalized) throw new Error(`Unsupported connected integration provider: ${provider}`);
  const capabilities = Array.isArray(definition.capabilities) ? definition.capabilities : [];
  const allowedCapabilityIds = new Set(connectedIntegrationCapabilityIds(normalized));
  const invalidCapability = capabilities.find((capabilityId) => !allowedCapabilityIds.has(capabilityId));
  if (invalidCapability) {
    throw new Error(`Capability ${invalidCapability} is not declared by ${normalized}.`);
  }
  return {
    provider: normalized as TProvider,
    setupSurface: "oauth_connector",
    ...definition,
    capabilities,
  };
}
