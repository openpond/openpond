import { randomUUID } from "node:crypto";

import { apiFetch, readApiJson } from "@openpond/cloud/api/core";

export type OpenPondWorkflowWeekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export type OpenPondWorkflowRecurrence = {
  version: 1;
  kind: "once" | "daily" | "weekdays" | "weekly" | "monthly";
  timeZone: string;
  startDate: string;
  localTime: string;
  weekdays?: OpenPondWorkflowWeekday[];
  dayOfMonth?: number;
  end:
    | { kind: "never" }
    | { kind: "on_date"; date: string }
    | { kind: "after_occurrences"; occurrences: number };
};

export type OpenPondWorkflowSchedule = {
  id: string;
  expression: string | null;
  timeZone: string;
  recurrence: OpenPondWorkflowRecurrence | null;
  configurationVersion: number;
  enabled: boolean;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  delivery: Record<string, unknown>;
};

export type OpenPondWorkflowDefinition = {
  id: string;
  definitionKey: string;
  version: number;
  name: string;
  prompt: string;
  modelId: string;
  schedules: OpenPondWorkflowSchedule[];
};

export type OpenPondWorkflowRun = {
  id: string;
  definitionId: string;
  scheduleId: string | null;
  definitionName: string;
  definitionVersion: number;
  conversationId: string;
  triggerKind: "manual" | "schedule" | "webhook" | "retry";
  status: string;
  notificationStatus: string;
  deliveryStatus: string;
  deliveryError: string | null;
  createdAt: string;
};

export type OpenPondWorkflowCatalog = {
  definitions: OpenPondWorkflowDefinition[];
  runs: OpenPondWorkflowRun[];
  asOf: string;
};

export type OpenPondWorkflowCreateInput = {
  clientRequestId?: string;
  sourceTurnId?: string | null;
  name: string;
  prompt: string;
  recurrence: OpenPondWorkflowRecurrence;
  modelId?: string;
};

export type OpenPondWorkflowCreateResult = {
  created: boolean;
  definitionId: string;
  scheduleId: string;
  name: string;
  enabled: boolean;
  nextRunAt: string | null;
  recurrence: OpenPondWorkflowRecurrence | null;
  timeZone: string;
};

export type OpenPondWorkflowUpdateInput =
  | { enabled: boolean }
  | {
      name: string;
      prompt: string;
      recurrence: OpenPondWorkflowRecurrence;
    };

export type OpenPondWorkflowUpdateResult = {
  definitionId?: string;
  schedule: {
    id: string;
    enabled: boolean;
    nextRunAt: string | null;
  };
};

export type OpenPondWorkflowDeleteResult = {
  schedule: {
    id: string;
    archived: true;
  };
};

export type OpenPondWorkflowRunNowResult = {
  runId: string;
  conversationId: string;
};

export type OpenPondWorkflowRequestOptions = {
  signal?: AbortSignal;
};

type WorkflowsClientInput = {
  apiKey: string;
  apiBaseUrl: string;
};

export class OpenPondWorkflowsClient {
  readonly #apiKey: string;
  readonly #apiBaseUrl: string;

  constructor(input: WorkflowsClientInput) {
    this.#apiKey = input.apiKey;
    this.#apiBaseUrl = input.apiBaseUrl.replace(/\/+$/, "");
  }

  async list(
    options: OpenPondWorkflowRequestOptions = {},
  ): Promise<OpenPondWorkflowCatalog> {
    return this.#request<OpenPondWorkflowCatalog>("", "List Workflows", {
      signal: options.signal,
    });
  }

  async create(
    input: OpenPondWorkflowCreateInput,
    options: OpenPondWorkflowRequestOptions = {},
  ): Promise<OpenPondWorkflowCreateResult> {
    return this.#request<OpenPondWorkflowCreateResult>("", "Create Workflow", {
      method: "POST",
      body: JSON.stringify({
        ...input,
        clientRequestId: input.clientRequestId?.trim() || randomUUID(),
      }),
      signal: options.signal,
    });
  }

  async update(
    scheduleId: string,
    input: OpenPondWorkflowUpdateInput,
    options: OpenPondWorkflowRequestOptions = {},
  ): Promise<OpenPondWorkflowUpdateResult> {
    return this.#request<OpenPondWorkflowUpdateResult>(
      `/schedules/${encodeURIComponent(requiredId(scheduleId, "scheduleId"))}`,
      "Update Workflow",
      {
        method: "PATCH",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
  }

  async delete(
    scheduleId: string,
    options: OpenPondWorkflowRequestOptions = {},
  ): Promise<OpenPondWorkflowDeleteResult> {
    return this.#request<OpenPondWorkflowDeleteResult>(
      `/schedules/${encodeURIComponent(requiredId(scheduleId, "scheduleId"))}`,
      "Delete Workflow",
      { method: "DELETE", signal: options.signal },
    );
  }

  async runNow(
    scheduleId: string,
    input: { clientRequestId?: string } = {},
    options: OpenPondWorkflowRequestOptions = {},
  ): Promise<OpenPondWorkflowRunNowResult> {
    return this.#request<OpenPondWorkflowRunNowResult>(
      `/schedules/${encodeURIComponent(requiredId(scheduleId, "scheduleId"))}/run`,
      "Run Workflow",
      {
        method: "POST",
        body: JSON.stringify({
          clientRequestId: input.clientRequestId?.trim() || randomUUID(),
        }),
        signal: options.signal,
      },
    );
  }

  async #request<T>(
    suffix: string,
    label: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await apiFetch(
      this.#apiBaseUrl,
      this.#apiKey,
      `/v1/saved-work${suffix}`,
      options,
    );
    return readApiJson<T>(response, label);
  }
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
