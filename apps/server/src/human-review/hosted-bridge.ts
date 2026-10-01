import { z } from "zod";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";
import { LearningDomainError } from "@openpond/evals/learning";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";

export class HumanReviewBridgeError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) { super(message); this.name = "HumanReviewBridgeError"; }
}

/** Desktop holds credentials while the hosted review owner enforces roles. */
export function createHostedHumanReviewBridge(deps: {
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
}) {
  return { async request(raw: unknown, signal?: AbortSignal) {
    assertBoundedTaskJson(raw, 1_048_576);
    const request = z.object({ scope: z.string().trim().min(1).max(191) }).passthrough().parse(raw);
    const access = await deps.resolveAccess();
    if (request.scope !== access.teamId) throw new LearningDomainError("human_scope_changed", 403, "The active workspace changed. Refresh before continuing.");
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    headers.set("content-type", "application/json");
    const response = await fetch(`${access.apiBaseUrl.replace(/\/+$/, "")}/v1/human-review`, {
      method: "POST", redirect: "error", headers, body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new HumanReviewBridgeError("human_response_unavailable", 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_097_152) throw new HumanReviewBridgeError("human_response_too_large", 502);
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      const error = z.object({ code: z.string().optional(), error: z.string().optional() }).passthrough().safeParse(value);
      throw new HumanReviewBridgeError(error.success ? error.data.code ?? "human_request_failed" : "human_request_failed", response.status, error.success ? error.data.error : undefined);
    }
    const current = await deps.resolveAccess();
    if (current.teamId !== access.teamId || current.token !== access.token || new URL(current.apiBaseUrl).origin !== new URL(access.apiBaseUrl).origin)
      throw new LearningDomainError("human_scope_changed", 403, "The active account or workspace changed. Refresh before continuing.");
    return value;
  } };
}
