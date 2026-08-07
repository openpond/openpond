import {
  createOpenPondSandboxClient,
  type OpenPondSandboxClient,
} from "@openpond/cloud/sandbox/client";
import { resolveOpChatApiBaseUrl } from "@openpond/cloud/hosted-chat";

import { OpenPondWorkClient } from "./work.js";
import type { OpenPondClientOptions } from "./types.js";

export class OpenPondClient {
  readonly sandboxes: OpenPondSandboxClient;
  readonly work: OpenPondWorkClient;

  constructor(options: OpenPondClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("OpenPond API key is required");

    const apiBaseUrl = options.baseUrl?.trim() || "https://api.openpond.ai";
    this.sandboxes = createOpenPondSandboxClient({
      apiKey,
      baseUrl: apiBaseUrl,
      sandboxApiUrl: options.sandboxApiUrl,
    });
    this.work = new OpenPondWorkClient({
      apiKey,
      apiBaseUrl,
      chatApiBaseUrl:
        options.chatApiUrl?.trim() ||
        resolveOpChatApiBaseUrl({ apiBaseUrl, env: {} }),
      sandboxes: this.sandboxes,
    });
  }
}

export function createOpenPondClient(options: OpenPondClientOptions): OpenPondClient {
  return new OpenPondClient(options);
}

export type { OpenPondClientOptions } from "./types.js";
export { OpenPondWorkClient } from "./work.js";
export { OpenPondApiError } from "@openpond/cloud/api/core";
export type {
  OpenPondWorkEvent,
  OpenPondWorkCleanup,
  OpenPondWorkHistoryMessage,
  OpenPondWorkInputFile,
  OpenPondWorkLifecycle,
  OpenPondWorkOutput,
  OpenPondWorkOutputPersistenceContext,
  OpenPondWorkRunInput,
  OpenPondWorkRunResult,
} from "./work.js";

export * from "@openpond/cloud/sandbox/client";
export * from "@openpond/cloud/sandbox/types";
export {
  getOpChatModel,
  getOpChatProvider,
  listOpChatModels,
  listOpChatProviders,
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  streamHostedChatTurn,
} from "@openpond/cloud/hosted-chat";
export type {
  HostedChatCompletion,
  HostedChatMessage,
  HostedChatStreamDelta,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatUsage,
  HostedModel,
  HostedModelsResponse,
  HostedProvider,
  HostedProvidersResponse,
} from "@openpond/cloud/hosted-chat";
