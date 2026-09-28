import { randomUUID } from "node:crypto";
import { HOST_STORAGE_CONTRACT_VERSION, HostedSandboxActionSchema,
  type AgentHostStorageClient } from "@openpond/agent-runtime";
import type { AppServerEmbeddingOptions } from "./app-server-embedding.js";
import type { AppServerSandboxRequest } from "./app-server-sandbox-tools.js";

/** The child's tool names do not confer authority; the host authorizes every invocation. */
export function createHostedEmbeddingAdapter(
  client: AgentHostStorageClient,
  allowedTools: readonly string[],
): AppServerEmbeddingOptions {
  return {
    allowedTools,
    authorizeTool: async (context) => {
      const result = await client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(), operation: "embedding/authorize",
        params: { sessionId: context.session.id, turnId: context.turnId, name: context.name },
      });
      if (!result || typeof result !== "object" || Array.isArray(result) ||
          (result as Record<string, unknown>).allowed !== true) {
        throw new Error("Hosted tool authorization denied.");
      }
    },
  };
}

/** Sandbox actions are restricted twice: by the child contract and by the host's lease policy. */
export function createHostedSandboxRequest(client: AgentHostStorageClient): AppServerSandboxRequest {
  return async (action) => {
    const admittedAction = HostedSandboxActionSchema.parse(action);
    return client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(), operation: "sandbox/request",
      params: { action: admittedAction },
    }, 60_000);
  };
}
