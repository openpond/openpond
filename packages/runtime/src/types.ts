import type {
  ActiveProfileSelector,
  ConfiguredProfile,
  HostedChatMessage,
  HostedChatStreamDelta,
  HostedModel,
  HostedProvider,
} from "@openpond/cloud";
import type {
  AccountState,
  OpenPondApp,
  ProviderCatalog,
} from "@openpond/contracts";

export type RuntimeLocalSession = {
  token?: string;
  appId?: string | null;
  conversationId?: string | null;
};

export type RuntimeLocalAccount = {
  handle: string;
  apiKey?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  chatApiBaseUrl?: string;
  environment?: string;
  session?: RuntimeLocalSession;
  token?: string;
};

export type RuntimeLocalConfig = {
  accounts?: RuntimeLocalAccount[];
  activeProfile?: ActiveProfileSelector;
  baseUrl?: string;
  apiBaseUrl?: string;
  chatApiBaseUrl?: string;
};

export type RuntimeAccountContext = {
  config: RuntimeLocalConfig;
  profiles: ConfiguredProfile[];
  account: RuntimeLocalAccount | null;
  token: string | null;
  apiBaseUrl: string;
  chatApiBaseUrl: string;
  accountState: AccountState;
};

export type AppsLoadResult = {
  account: AccountState;
  apps: OpenPondApp[];
  error: string | null;
};

export type OpenPondActionResult = {
  ok: boolean;
  action: string;
  appId: string | null;
  output: string;
  data?: unknown;
  relatedDeploymentId?: string;
};

export type HostedChatModel = {
  id: string;
  displayName: string;
  ownedBy: string | null;
  streaming: boolean;
  raw: HostedModel;
};

export type HostedChatModelsResult = {
  models: HostedChatModel[];
  error: string | null;
};

export type HostedChatProvider = {
  id: string;
  displayName: string;
  ownedBy: string | null;
  lifecycleStatus: string | null;
  modelIds: string[];
  raw: HostedProvider;
};

export type HostedChatProvidersResult = {
  providers: HostedChatProvider[];
  error: string | null;
};

export type HostedProviderCatalogResult = {
  catalog: ProviderCatalog | null;
  error: string | null;
};

export type HostedChatTurnInput = {
  model?: string | null;
  messages: HostedChatMessage[];
  requestId?: string;
  signal?: AbortSignal;
};

export type HostedChatTurnDelta = HostedChatStreamDelta;

export type SaveOpenPondAccountInput = {
  handle?: string | null;
  apiKey: string;
  baseUrl?: string | null;
  apiBaseUrl?: string | null;
  chatApiBaseUrl?: string | null;
  environment?: string | null;
  setActive?: boolean;
};

export type UpdateOpenPondAccountConfigInput = {
  handle: string;
  currentBaseUrl?: string | null;
  baseUrl?: string | null;
  apiBaseUrl?: string | null;
  chatApiBaseUrl?: string | null;
  environment?: string | null;
  setActive?: boolean;
};
