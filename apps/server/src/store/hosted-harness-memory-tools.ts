import { randomUUID } from "node:crypto";

import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";

import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";
import { loadHostedHarnessRuntimeForSession } from "./hosted-harness-runtime.js";

/** Memory reads use the host-admitted owner and Profile collection. */
export function createHostedHarnessMemoryTools(client: AgentHostStorageClient): ModelToolDefinition[] {
  async function workspaceId(session: Parameters<typeof loadHostedHarnessRuntimeForSession>[1]): Promise<string> {
    const runtime = await loadHostedHarnessRuntimeForSession(client, session);
    if (!runtime) throw new Error("No hosted Harness is selected for this run.");
    return runtime.workspace.id;
  }
  return [
    {
      name: "memory_search",
      description: "Search bounded active memory for this selected Harness or Profile. Returns keys, revisions and short excerpts.",
      parameters: { type: "object", additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: 500 },
          limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] },
      execute: async (context) => {
        const query = context.args.query;
        if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("Memory query is invalid.");
        const limit = context.args.limit === undefined ? 8 : context.args.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
          throw new Error("Memory search limit is invalid.");
        }
        const result = await client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
          requestId: randomUUID(), operation: "harness/memory/search",
          params: { workspaceId: await workspaceId(context.session), query, limit } });
        return { toolCallId: context.callId, name: "memory_search", ok: true,
          contentText: JSON.stringify(result), data: result };
      },
    },
    {
      name: "memory_inspect",
      description: "Read one exact active memory entry returned by memory_search.",
      parameters: { type: "object", additionalProperties: false,
        properties: { key: { type: "string", minLength: 1, maxLength: 120 } }, required: ["key"] },
      execute: async (context) => {
        const key = context.args.key;
        if (typeof key !== "string" || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(key)) {
          throw new Error("Memory key is invalid.");
        }
        const entry = await client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
          requestId: randomUUID(), operation: "harness/memory/get",
          params: { workspaceId: await workspaceId(context.session), key } });
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            (entry as Record<string, unknown>).status !== "active") {
          throw new Error(`Harness memory does not exist: ${key}.`);
        }
        return { toolCallId: context.callId, name: "memory_inspect", ok: true,
          contentText: JSON.stringify(entry), data: entry };
      },
    },
  ];
}
