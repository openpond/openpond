import { randomUUID } from "node:crypto";
import { HOST_STORAGE_CONTRACT_VERSION, HostStorageRequestSchema, type AgentHostStorageClient } from "@openpond/agent-runtime";
import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";

/** Published files are read by the owner host, independently of sandbox lifetime. */
export function createHostedWorkOutputTools(client: AgentHostStorageClient): ModelToolDefinition[] {
  return [
    {
      name: "work_list_outputs",
      description: "List this conversation's published outputs from completed turns without starting sandbox compute. Use this before reading a previously saved file; returns exact file IDs and revisions. New workspace files are published after the current turn ends. Inspect those with workspace tools and finish the turn instead of polling this list.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async context => {
        const result = await client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
          requestId: randomUUID(), operation: "output/list", params: {} });
        return { toolCallId: context.callId, name: "work_list_outputs", ok: true,
          contentText: JSON.stringify(result), data: result };
      },
    },
    {
      name: "work_read_output",
      description: "Read the actual saved text/Markdown or PDF text of a file returned by work_list_outputs, without starting sandbox compute. Prefer this for questions about saved outputs. Use workspace tools for edits, execution and unsaved files. PDF text extraction does not inspect images or page appearance.",
      parameters: { type: "object", additionalProperties: false, properties: {
        fileId: { type: "string", minLength: 1, maxLength: 191 },
        revision: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0, maximum: 10_000_000 },
        maxChars: { type: "integer", minimum: 1, maximum: 100_000 },
        firstPage: { type: "integer", minimum: 1, maximum: 1000 },
        pageCount: { type: "integer", minimum: 1, maximum: 10 },
      }, required: ["fileId", "revision"] },
      execute: async context => {
        const result = await client.request(HostStorageRequestSchema.parse({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
          requestId: randomUUID(), operation: "output/read", params: context.args }), 60_000);
        return { toolCallId: context.callId, name: "work_read_output", ok: true,
          contentText: JSON.stringify(result), data: result };
      },
    },
  ];
}
