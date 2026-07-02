/// <reference types="vite/client" />

declare module "monaco-editor/esm/vs/basic-languages/*/*" {
  import type * as monaco from "monaco-editor";

  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/language/*/monaco.contribution" {
  const contribution: unknown;
  export default contribution;
}

declare module "monaco-editor/esm/vs/basic-languages/css/css" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/html/html" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/javascript/javascript" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/markdown/markdown" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/python/python" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/shell/shell" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/typescript/typescript" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/basic-languages/yaml/yaml" {
  import type * as monaco from "monaco-editor";
  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

type OpenPondConnection = {
  serverUrl: string;
  token: string;
  platform: string;
};

type OpenPondLogLine = {
  file: string;
  line: string;
  timestamp: number;
  index: number;
};

type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserCommandResult = {
  ok: boolean;
  error?: string;
};

type BrowserConversationInput = {
  conversationId: string;
};

type BrowserTabInput = BrowserConversationInput & {
  tabId: string;
};

type BrowserUrlInput = BrowserConversationInput & {
  url: string;
  explicitFile?: boolean;
};

type BrowserOpenInput = BrowserUrlInput;

type BrowserNewTabInput = BrowserConversationInput & {
  url?: string;
  explicitFile?: boolean;
};

type BrowserNavigateInput = BrowserTabInput & {
  url: string;
  explicitFile?: boolean;
};

type BrowserBoundsInput = BrowserConversationInput & {
  bounds: BrowserBounds | null;
};

type BrowserTabState = {
  id: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
};

type BrowserConversationState = {
  conversationId: string;
  activeTabId: string | null;
  tabs: BrowserTabState[];
};

type BrowserDiagnostics = {
  activeConversationId: string | null;
  attachedRuntimeCount: number;
  limits: {
    conversationInactiveViewLimit: number;
    globalWarmViewLimit: number;
    idleViewTtlMs: number;
  };
  pendingStateEmitCount: number;
  pendingTabPersistCount: number;
  recentEvictions: Array<{
    at: number;
    conversationId: string;
    reason: "idle_ttl" | "conversation_inactive_limit" | "global_warm_view_limit";
    runtimeCount: number;
    tabId: string;
  }>;
  runtimeCount: number;
};

interface Window {
  __OPENPOND_WEB_CONNECTION__?: {
    serverUrl?: string;
    token?: string;
  };
  openpond?: {
    getConnection: () => Promise<OpenPondConnection>;
    browser?: {
      open: (input: BrowserOpenInput) => Promise<BrowserCommandResult>;
      newTab: (input: BrowserNewTabInput) => Promise<BrowserCommandResult>;
      selectTab: (input: BrowserTabInput) => Promise<BrowserCommandResult>;
      closeTab: (input: BrowserTabInput) => Promise<BrowserCommandResult>;
      navigate: (input: BrowserNavigateInput) => Promise<BrowserCommandResult>;
      back: (input: BrowserTabInput) => Promise<BrowserCommandResult>;
      forward: (input: BrowserTabInput) => Promise<BrowserCommandResult>;
      reload: (input: BrowserTabInput) => Promise<BrowserCommandResult>;
      stop: (input: BrowserTabInput) => Promise<BrowserCommandResult>;
      close: (input: BrowserConversationInput) => Promise<BrowserCommandResult>;
      clearData: (input: BrowserConversationInput) => Promise<BrowserCommandResult>;
      openExternal: (input: BrowserTabInput | BrowserUrlInput) => Promise<BrowserCommandResult>;
      setBounds: (input: BrowserBoundsInput) => Promise<BrowserCommandResult>;
      getState: (input: BrowserConversationInput) => Promise<BrowserConversationState>;
      diagnostics: () => Promise<BrowserDiagnostics>;
      onState: (callback: (state: BrowserConversationState) => void) => () => void;
    };
    retryStartup?: () => Promise<{ ok: boolean; error?: string }>;
    openLogsFolder?: () => Promise<{ ok: boolean; error?: string }>;
    readRecentLogs?: (lineLimit?: number) => Promise<
      | { ok: true; logDir: string; lineLimit: number; lines: OpenPondLogLine[] }
      | { ok: false; error: string }
    >;
    copyRecentLogs?: (lineLimit?: number) => Promise<{ ok: boolean; lines?: number; error?: string }>;
    exportDiagnostics?: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    selectFolder?: () => Promise<{ canceled: boolean; path: string | null }>;
    requestMicrophoneAccess?: () => Promise<boolean>;
    logRendererError?: (payload: unknown) => Promise<boolean>;
    minimizeWindow?: () => Promise<boolean>;
    toggleMaximizeWindow?: () => Promise<boolean>;
    closeWindow?: () => Promise<boolean>;
  };
}
