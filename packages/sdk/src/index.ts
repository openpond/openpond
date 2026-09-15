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
import { OpenPondLearningClient } from "./learning-client.js";
import { configuredEndpoint, configuredKey } from "./work-sandbox.js";

export class OpenPondClient {
  readonly sandboxes: OpenPondSandboxClient;
  readonly work: OpenPondWorkClient;
  readonly workflows: OpenPondWorkflowsClient;
  readonly actions: OpenPondProjectActionsClient;
  readonly profileActions: OpenPondProfileActionsClient;
  readonly learning: (scope: string) => OpenPondLearningClient;

  constructor(options: OpenPondClientOptions) {
    const apiKey = options.apiKey?.trim() ?? "";
    if (!apiKey && (!options.sandbox || !options.model))
      throw new Error("OpenPond API key is required when using a default sandbox or model");
    const sandbox = options.sandbox ? {
      ...options.sandbox,
      endpoint: configuredEndpoint(options.sandbox.endpoint, "Sandbox endpoint"),
      apiKey: configuredKey(options.sandbox.apiKey, "Sandbox API key"),
    } : undefined;
    const model = options.model ? {
      endpoint: configuredEndpoint(options.model.endpoint, "Model endpoint"),
      apiKey: configuredKey(options.model.apiKey, "Model API key"),
      model: configuredKey(options.model.model, "Model ID"),
    } : undefined;

    const apiBaseUrl = options.baseUrl?.trim() || "https://api.openpond.ai";
    this.learning = (scope) => new OpenPondLearningClient({ apiKey, baseUrl: apiBaseUrl, scope });
    this.sandboxes = createOpenPondSandboxClient({
      apiKey: sandbox?.apiKey ?? apiKey,
      baseUrl: apiBaseUrl,
      sandboxApiUrl: sandbox?.endpoint ?? options.sandboxApiUrl,
    });
    this.work = new OpenPondWorkClient({
      apiKey: model?.apiKey ?? apiKey,
      apiBaseUrl,
      chatApiBaseUrl:
        model?.endpoint || options.chatApiUrl?.trim() ||
        resolveOpChatApiBaseUrl({ apiBaseUrl, env: {} }),
      sandboxes: this.sandboxes,
      sandboxConfig: sandbox,
      defaultModel: model?.model,
      customModel: Boolean(model),
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
export { OpenPondLearningClient, OpenPondLearningError } from "./learning-client.js";
export type { OpenPondLearningClientOptions, LearningRequestOptions } from "./learning-client.js";

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
