import { apiFetch, readApiJson } from "@openpond/cloud/api/core";

import { resolveHostedApiAccess } from "../openpond/hosted-api-access.js";

export type HostedProjectActionInvocation = {
  id: string;
  releaseId: string;
  actionId: string;
  status: "running" | "succeeded" | "failed";
  resultJson: Record<string, unknown>;
  traceJson: Record<string, unknown>[];
  outputJson: Record<string, unknown>[];
  failureCode?: string | null;
  failureMessage?: string | null;
};

export async function runHostedProjectAction(input: {
  projectId: string;
  teamId: string;
  releaseId: string;
  actionId: string;
  value: unknown;
  idempotencyKey?: string;
  callerId?: string;
  signal?: AbortSignal;
}, dependencies: {
  resolveAccess?: typeof resolveHostedApiAccess;
  fetch?: typeof apiFetch;
} = {}): Promise<HostedProjectActionInvocation> {
  const access = await (dependencies.resolveAccess ?? resolveHostedApiAccess)();
  const response = await (dependencies.fetch ?? apiFetch)(
    access.apiBaseUrl,
    access.token,
    `/v1/project-actions/${encodeURIComponent(input.projectId)}/actions/${encodeURIComponent(input.actionId)}?teamId=${encodeURIComponent(input.teamId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        input: input.value,
        releaseId: input.releaseId,
        idempotencyKey: input.idempotencyKey,
        callerType: "work",
        callerId: input.callerId,
      }),
      signal: input.signal,
      timeoutMs: 15 * 60 * 1000,
    },
  );
  const payload = await readApiJson<{ invocation: HostedProjectActionInvocation }>(
    response,
    "Run hosted Project Action",
  );
  if (payload.invocation.status === "failed") {
    throw new Error(
      payload.invocation.failureMessage ||
        payload.invocation.failureCode ||
        "Hosted Project Action failed.",
    );
  }
  return payload.invocation;
}
