import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AcpAgentConfigSchema, isRegisteredAcpProvider, type ProviderSettings } from "@openpond/contracts/providers";
import { updateProvidersFile, mergeProviderConfigPatch } from "../../openpond/provider-settings.js";
import { fetchAcpRegistry, chooseAcpDistribution, acpPlatform } from "./acp-registry.js";
import { installAcpAgent } from "./acp-install.js";

export function createAcpRegistrationService(providersFilePath: string, providerSettingsPayload: (options: { refreshCatalog: boolean }) => Promise<ProviderSettings>) {
  const now = () => new Date().toISOString();
  return async (action: string, payload: unknown) => {
      if (action === "list") {
        const query = z.object({ query: z.string().max(200).optional(), refresh: z.boolean().optional() }).parse(payload);
        const catalog = await fetchAcpRegistry(query.refresh);
        const search = query.query?.trim().toLowerCase() ?? "";
        return { fetchedAt: catalog.fetchedAt, platform: acpPlatform(), agents: catalog.agents.filter(agent => !search || `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(search)).map(agent => ({ ...agent, supported: Boolean(chooseAcpDistribution(agent)) })) };
      }
      if (action === "remove") {
        const { providerId } = z.object({ providerId: z.string() }).parse(payload);
        if (!isRegisteredAcpProvider(providerId)) throw new Error("Only registered ACP agents can be removed.");
        await updateProvidersFile(providersFilePath, current => { const next = { ...current, providers: { ...current.providers }, modelCaches: { ...current.modelCaches } }; delete next.providers[providerId]; delete next.modelCaches[providerId]; return next; });
        return { settings: await providerSettingsPayload({ refreshCatalog: false }) };
      }
      if (action !== "register") throw new Error("Unknown ACP registry action.");
      const request = z.object({ displayName: z.string().trim().min(1).max(160).optional(), registryId: z.string().max(160).optional(), version: z.string().max(200).optional(), distribution: z.enum(["binary", "npx", "uvx"]).optional(), custom: AcpAgentConfigSchema.optional() }).parse(payload);
      let config;
      if (request.registryId) {
        const catalog = await fetchAcpRegistry();
        const agent = catalog.agents.find(entry => entry.id === request.registryId);
        if (!agent || request.version !== agent.version) throw new Error("The registry entry changed. Refresh the catalog before adding this agent.");
        config = await installAcpAgent(path.dirname(providersFilePath), agent, request.distribution);
      } else {
        if (!request.custom) throw new Error("Specify a registry agent or a custom ACP command.");
        config = { ...request.custom, registryId: null, version: null };
      }
      if (request.displayName) config.displayName = request.displayName;
      const providerId = `acp:${randomUUID()}`;
      await updateProvidersFile(providersFilePath, current => mergeProviderConfigPatch({ value: current, providerId, patch: { acp: config, enabled: true }, updatedAt: now() }));
      return { providerId, settings: await providerSettingsPayload({ refreshCatalog: false }) };
    };
}
