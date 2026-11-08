import { DEFAULT_API_BASE_URL } from "./endpoints.js";
import {
  createProductModels,
  type ProductModelBinding,
  type ProductModels,
} from "./product-models.js";
import {
  addDatasetTask,
  type DatasetTaskInput,
  type AddTaskOptions,
  type DatasetTaskAppendReceipt,
} from "./dataset-task-ingestion.js";
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
import { OpenPondExperimentsClient } from "./experiment-client.js";
import { ConnectedEvidenceClient } from "./connected-evidence.js";
import { OpenPondHumanReviewClient } from "./human-review-client.js";
import { configuredEndpoint, configuredKey } from "./work-sandbox.js";

export class OpenPondClient<
  Models extends Record<string, string | ProductModelBinding> = Record<string, never>,
> {
  readonly models: ProductModels<Models>;
  readonly dataset: (datasetId: string) => {
    addTask: (
      task: DatasetTaskInput,
      options?: AddTaskOptions,
    ) => Promise<DatasetTaskAppendReceipt>;
  };
  readonly addTask: {
    (task: DatasetTaskInput, options?: AddTaskOptions): Promise<DatasetTaskAppendReceipt>;
    (
      datasetId: string,
      task: DatasetTaskInput,
      options?: AddTaskOptions,
    ): Promise<DatasetTaskAppendReceipt>;
  };
  readonly sandboxes: OpenPondSandboxClient;
  readonly work: OpenPondWorkClient;
  readonly workflows: OpenPondWorkflowsClient;
  readonly actions: OpenPondProjectActionsClient;
  readonly profileActions: OpenPondProfileActionsClient;
  readonly learning: (scope: string) => OpenPondLearningClient;
  readonly experiments: (teamId: string) => OpenPondExperimentsClient;
  readonly connectedEvidence: (teamId: string) => ConnectedEvidenceClient;
  readonly humanReview: (scope: string) => OpenPondHumanReviewClient;

  constructor(options: OpenPondClientOptions<Models>) {
    const apiKey = options.apiKey?.trim() ?? "";
    if (!apiKey && (!options.sandbox || !options.model))
      throw new Error("OpenPond API key is required when using a default sandbox or model");
    const sandbox = options.sandbox
      ? {
          ...options.sandbox,
          endpoint: configuredEndpoint(options.sandbox.endpoint, "Sandbox endpoint"),
          apiKey: configuredKey(options.sandbox.apiKey, "Sandbox API key"),
        }
      : undefined;
    const model = options.model
      ? {
          endpoint: configuredEndpoint(options.model.endpoint, "Model endpoint"),
          apiKey: configuredKey(options.model.apiKey, "Model API key"),
          model: configuredKey(options.model.model, "Model ID"),
        }
      : undefined;

    const apiBaseUrl = options.baseUrl?.trim() || DEFAULT_API_BASE_URL;
    const taskTeamId = options.teamId ?? "";
    const defaultDatasetId = options.datasetId;
    const connection = { apiKey, baseUrl: apiBaseUrl, teamId: taskTeamId, fetch: options.fetch };
    this.dataset = (datasetId) => ({
      addTask: (task, taskOptions) => addDatasetTask(connection, datasetId, task, taskOptions),
    });
    this.addTask = ((
      destination: string | DatasetTaskInput,
      taskOrOptions?: DatasetTaskInput | AddTaskOptions,
      taskOptions?: AddTaskOptions,
    ) => {
      if (typeof destination === "string")
        return this.dataset(destination).addTask(taskOrOptions as DatasetTaskInput, taskOptions);
      if (!defaultDatasetId)
        throw new Error("Configure datasetId or use client.dataset(datasetId).addTask(task).");
      return this.dataset(defaultDatasetId).addTask(
        destination,
        taskOrOptions as AddTaskOptions | undefined,
      );
    }) as OpenPondClient<Models>["addTask"];
    this.models = createProductModels(options.models ?? ({} as Models), {
      baseUrl: `${apiBaseUrl.replace(/\/+$/, "")}/v1`,
      ...options.serving,
      apiKey: options.serving?.apiKey ?? apiKey,
      teamId: taskTeamId,
      fetch: options.fetch,
    });
    this.learning = (scope) => new OpenPondLearningClient({ apiKey, baseUrl: apiBaseUrl, scope });
    this.experiments = (teamId) =>
      new OpenPondExperimentsClient({ apiKey, baseUrl: apiBaseUrl, teamId });
    this.connectedEvidence = (teamId) =>
      new ConnectedEvidenceClient({ apiKey, baseUrl: apiBaseUrl, teamId });
    this.humanReview = (scope) =>
      new OpenPondHumanReviewClient({ apiKey, baseUrl: apiBaseUrl, scope });
    this.sandboxes = createOpenPondSandboxClient({
      apiKey: sandbox?.apiKey ?? apiKey,
      baseUrl: apiBaseUrl,
      sandboxApiUrl: sandbox?.endpoint ?? options.sandboxApiUrl,
      customEndpoint: Boolean(sandbox),
    });
    this.work = new OpenPondWorkClient({
      apiKey: model?.apiKey ?? apiKey,
      apiBaseUrl,
      chatApiBaseUrl:
        model?.endpoint ||
        options.chatApiUrl?.trim() ||
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

export function createOpenPondClient<
  const Models extends Record<string, string | ProductModelBinding> = Record<string, never>,
>(options: OpenPondClientOptions<Models>): OpenPondClient<Models> {
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
export * from "./human-review.js";
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

export * from "./connected-evidence.js";
export * from "./candidate-evaluations.js";
export * from "./experiment-improvements.js";

export * from "./experiment-evaluation-schedules.js";
export * from "./advanced-refiner-evaluations.js";

export { createTaskAdder, DatasetTaskIngestionError } from "./dataset-task-ingestion.js";
export type {
  DatasetTaskInput,
  DatasetTaskAppendReceipt,
  AddTaskOptions,
} from "./dataset-task-ingestion.js";

export * from "./product-models.js";
