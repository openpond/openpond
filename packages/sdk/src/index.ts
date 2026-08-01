import {
  createOpenPondSandboxClient,
  type OpenPondSandboxClient,
} from "../../cloud/src/sandbox/client.js";
import { resolveOpChatApiBaseUrl } from "../../cloud/src/hosted-chat.js";

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
export { OpenPondNonExecutingSandboxError, OpenPondWorkClient } from "./work.js";
export type {
  OpenPondWorkEvent,
  OpenPondWorkHistoryMessage,
  OpenPondWorkRunInput,
  OpenPondWorkRunResult,
} from "./work.js";

export * from "../../cloud/src/sandbox/client.js";
export * from "../../cloud/src/sandbox/types/index.js";
export {
  getOpChatModel,
  getOpChatProvider,
  listOpChatModels,
  listOpChatProviders,
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  streamHostedChatTurn,
} from "../../cloud/src/hosted-chat.js";
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
} from "../../cloud/src/hosted-chat.js";
