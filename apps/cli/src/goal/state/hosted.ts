import { apiFetch, readApiJson } from "../../api/core";
import type {
  GoalAnswer,
  GoalApprovalRequest,
  GoalArtifact,
  GoalArtifactRef,
  GoalEvent,
  GoalLlmRequest,
  GoalLlmResponse,
  GoalQuestion,
  GoalRunConfig,
  GoalState,
} from "../types";

export function resolveHostedGoalCredential(): string | null {
  return (
    process.env.OPENPOND_GOAL_API_KEY?.trim() ||
    process.env.OPENPOND_API_KEY?.trim() ||
    null
  );
}

export function resolveHostedGoalApiUrl(): string | null {
  return (
    process.env.OPENPOND_GOAL_API_URL?.trim().replace(/\/$/, "") ||
    process.env.OPENPOND_API_URL?.trim().replace(/\/$/, "") ||
    null
  );
}

export class HostedGoalClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string
  ) {}

  private request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers || {});
    headers.set("openpond-api-key", this.apiKey);
    return apiFetch(this.apiUrl, this.apiKey, path, {
      ...init,
      headers,
    });
  }

  async getRunConfig(goalId: string): Promise<GoalRunConfig> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(goalId)}/run-config`
    );
    return readApiJson<GoalRunConfig>(response, "goal run-config");
  }

  async appendEvent(goalId: string, event: GoalEvent): Promise<void> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(goalId)}/events`,
      {
        method: "POST",
        body: JSON.stringify({ event }),
      }
    );
    await readApiJson<unknown>(response, "goal event");
  }

  async answerQuestion(params: {
    goalId: string;
    questionId: string;
    answer: GoalAnswer;
  }): Promise<void> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(params.goalId)}/questions/${encodeURIComponent(
        params.questionId
      )}/answers`,
      {
        method: "POST",
        body: JSON.stringify({ answer: params.answer }),
      }
    );
    await readApiJson<unknown>(response, "goal answer");
  }

  async createQuestion(goalId: string, question: GoalQuestion): Promise<void> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(goalId)}/questions`,
      {
        method: "POST",
        body: JSON.stringify({ question }),
      }
    );
    await readApiJson<unknown>(response, "goal question");
  }

  async requestApproval(request: GoalApprovalRequest): Promise<void> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(request.goalId)}/approvals`,
      {
        method: "POST",
        body: JSON.stringify({ approval: request }),
      }
    );
    await readApiJson<unknown>(response, "goal approval request");
  }

  async updateStatus(goalId: string, status: GoalState["status"]): Promise<void> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(goalId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }
    );
    await readApiJson<unknown>(response, "goal status update");
  }

  async pause(goalId: string): Promise<void> {
    await this.postLifecycle(goalId, "pause");
  }

  async resume(goalId: string): Promise<void> {
    await this.postLifecycle(goalId, "resume");
  }

  async cancel(goalId: string): Promise<void> {
    await this.postLifecycle(goalId, "cancel");
  }

  async approve(goalId: string, decisionNote?: string | null): Promise<void> {
    await this.postLifecycle(goalId, "approve", { decisionNote });
  }

  async reject(goalId: string, decisionNote?: string | null): Promise<void> {
    await this.postLifecycle(goalId, "reject", { decisionNote });
  }

  private async postLifecycle(
    goalId: string,
    action: "pause" | "resume" | "cancel" | "approve" | "reject",
    body?: Record<string, unknown>
  ): Promise<void> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(goalId)}/${action}`,
      {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }
    );
    await readApiJson<unknown>(response, `goal ${action}`);
  }

  async callLlm(request: GoalLlmRequest): Promise<GoalLlmResponse> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(request.goalId)}/llm`,
      {
        method: "POST",
        body: JSON.stringify(request),
      }
    );
    return readApiJson<GoalLlmResponse>(response, "goal llm call");
  }

  async uploadArtifact(artifact: GoalArtifact): Promise<GoalArtifactRef> {
    const response = await this.request(
      `/v1/goals/${encodeURIComponent(artifact.goalId)}/artifacts`,
      {
        method: "POST",
        body: JSON.stringify({ artifact }),
      }
    );
    return readApiJson<GoalArtifactRef>(response, "goal artifact upload");
  }
}
