import type {
  AccountState,
  Approval,
  CacheMetadata,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondApp,
  RuntimeEvent,
  ServerStatus,
  Session,
  Turn,
  ProviderConfig,
  ProviderCatalog,
  ProviderModelCache,
} from "@openpond/contracts";
import type {
  CodexAppServerClient,
  CodexServerRequest,
  CodexServerRequestResult,
} from "@openpond/codex-provider";
import type {
  BackgroundWorkReceipt,
  ServerWorkQueueId,
} from "./runtime/background-worker-queue.js";

export type StoreData = {
  sessions: Session[];
  turns: Turn[];
  events: RuntimeEvent[];
  approvals: Approval[];
};

export type RuntimeCodexSession = {
  client: CodexAppServerClient;
  threadId: string;
  cwd: string | null;
  permissionMode: CodexPermissionMode;
  reasoningEffort: CodexReasoningEffort | null;
};

export type PendingApproval = {
  approval: Approval;
  request: CodexServerRequest;
  resolve: (value: CodexServerRequestResult) => void;
};

export type OpenPondServerOptions = {
  host?: string;
  port?: number;
  storeDir?: string;
  webRoot?: string | null;
  version?: string;
  silent?: boolean;
};

export type OpenPondServerInstance = {
  url: string;
  token: string;
  tokenFile: string;
  storePath: string;
  status: ServerStatus;
  close: () => Promise<void>;
  testHooks: {
    drainWorkQueues: (queueId?: ServerWorkQueueId) => Promise<void>;
    workQueueReceipts: (queueId?: ServerWorkQueueId) => BackgroundWorkReceipt[];
  };
};

export type ProviderCatalogCache = {
  source: "hosted";
  fetchedAt: string;
  lastError: string | null;
  catalogHash: string | null;
  catalog: ProviderCatalog;
};

export type ProvidersFile = {
  version: 1;
  providers: Record<string, ProviderConfig>;
  modelCaches?: Record<string, ProviderModelCache>;
  catalogCache?: ProviderCatalogCache | null;
};

export type PayloadRow = {
  payload: string;
};

export type CacheRow = {
  payload: string;
  updated_at: string;
  error: string | null;
};

export type CacheEntryRow = CacheRow & {
  cache_key: string;
};

export type SidebarAppPreferenceRow = {
  app_id: string;
  pinned: number;
  archived: number;
  sort_order: number | null;
};

export type CacheEntry<T> = {
  payload: T;
  updatedAt: string;
  error: string | null;
};

export type OpenPondCachedData = {
  account: AccountState;
  apps: OpenPondApp[];
  appsError: string | null;
  appsMeta: CacheMetadata;
  accountMeta: CacheMetadata;
};
