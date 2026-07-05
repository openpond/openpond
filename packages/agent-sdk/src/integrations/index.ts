import {
  defineEnvSecret,
  defineIntegration,
  env,
  integration as baseIntegration,
  secret,
  type EnvSecretDefinition,
  type IntegrationDefinition,
} from "../index";
import {
  CONNECTED_INTEGRATION_PROVIDERS,
  connectedIntegrationCapabilityIds,
  connectedIntegrationCatalog,
  connectedIntegrationDefaultCapabilityIds,
  defineConnectedIntegration,
  isConnectedIntegrationProvider,
  normalizeConnectedIntegrationProvider,
  type ConnectedIntegrationDefinition,
  type ConnectedIntegrationProvider,
} from "../core/connected-integrations";

export const integration = {
  ...baseIntegration,
  google(definition: Omit<ConnectedIntegrationDefinition<"google">, "provider"> = {}) {
    return defineConnectedIntegration("google", definition);
  },
  github(definition: Omit<ConnectedIntegrationDefinition<"github">, "provider"> = {}) {
    return defineConnectedIntegration("github", definition);
  },
  x(definition: Omit<ConnectedIntegrationDefinition<"x">, "provider"> = {}) {
    return defineConnectedIntegration("x", definition);
  },
};

export const connectedIntegration = {
  providers: CONNECTED_INTEGRATION_PROVIDERS,
  catalog: connectedIntegrationCatalog,
  capabilityIds: connectedIntegrationCapabilityIds,
  defaultCapabilityIds: connectedIntegrationDefaultCapabilityIds,
  isProvider: isConnectedIntegrationProvider,
  normalizeProvider: normalizeConnectedIntegrationProvider,
  define: defineConnectedIntegration,
  google: integration.google,
  github: integration.github,
  x: integration.x,
};

export {
  CONNECTED_INTEGRATION_PROVIDERS,
  connectedIntegrationCapabilityIds,
  connectedIntegrationCatalog,
  connectedIntegrationDefaultCapabilityIds,
  defineConnectedIntegration,
  defineEnvSecret,
  defineIntegration,
  env,
  isConnectedIntegrationProvider,
  normalizeConnectedIntegrationProvider,
  secret,
};

export type {
  ConnectedIntegrationDefinition,
  ConnectedIntegrationProvider,
  EnvSecretDefinition,
  IntegrationDefinition,
};
