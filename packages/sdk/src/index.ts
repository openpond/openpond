import {
  createOpenPondSandboxClient,
  type OpenPondSandboxClient,
} from "@openpond/cloud/sandbox/client";
import { resolveOpChatApiBaseUrl } from "@openpond/cloud/hosted-chat";

import { OpenPondWorkClient } from "./work.js";
import { OpenPondProjectActionsClient } from "./project-actions.js";
import { OpenPondProfileActionsClient } from "./profile-actions.js";
import { OpenPondWorkflowsClient } from "./workflows.js";
import type { OpenPondClientOptions } from "./types.js";
import { OpenPondLearningClient } from "./learning.js";

export class OpenPondClient {
  readonly sandboxes: OpenPondSandboxClient;
  readonly work: OpenPondWorkClient;
  readonly workflows: OpenPondWorkflowsClient;
  readonly actions: OpenPondProjectActionsClient;
  readonly profileActions: OpenPondProfileActionsClient;
  readonly learning: (scope: string) => OpenPondLearningClient;

  constructor(options: OpenPondClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("OpenPond API key is required");

    const apiBaseUrl = options.baseUrl?.trim() || "https://api.openpond.ai";
    this.learning = (scope) => new OpenPondLearningClient({ apiKey, baseUrl: apiBaseUrl, scope });
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
    this.workflows = new OpenPondWorkflowsClient({ apiKey, apiBaseUrl });
    this.actions = new OpenPondProjectActionsClient({ apiKey, apiBaseUrl });
    this.profileActions = new OpenPondProfileActionsClient({ apiKey, apiBaseUrl });
  }
}

export function createOpenPondClient(options: OpenPondClientOptions): OpenPondClient {
  return new OpenPondClient(options);
}

export type { OpenPondClientOptions } from "./types.js";
export { OpenPondWorkClient } from "./work.js";
export { OpenPondWorkflowsClient } from "./workflows.js";
export { OpenPondProjectActionsClient } from "./project-actions.js";
export { OpenPondProfileActionsClient } from "./profile-actions.js";
export type {
  HostedProjectActionCatalog,
  ProjectActionInvocation,
  ProjectActionRelease,
} from "./project-actions.js";
export type {
  OpenPondProfileActionCatalog,
  OpenPondProfileActionCatalogEntry,
  OpenPondProfileActionInvocation,
  OpenPondProfileActionSetupRequirement,
} from "./profile-actions.js";
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
export type {
  OpenPondWorkflowCatalog,
  OpenPondWorkflowCreateInput,
  OpenPondWorkflowCreateResult,
  OpenPondWorkflowDefinition,
  OpenPondWorkflowDeleteResult,
  OpenPondWorkflowRecurrence,
  OpenPondWorkflowRequestOptions,
  OpenPondWorkflowRun,
  OpenPondWorkflowRunNowResult,
  OpenPondWorkflowSchedule,
  OpenPondWorkflowUpdateInput,
  OpenPondWorkflowUpdateResult,
  OpenPondWorkflowWeekday,
} from "./workflows.js";
export * from "./refiner.js";
export { OpenPondLearningClient, OpenPondLearningError } from "./learning.js";
export type { OpenPondLearningClientOptions, LearningRequestOptions } from "./learning.js";

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
