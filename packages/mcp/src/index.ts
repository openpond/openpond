import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createClients } from "./clients.js";
import { addProjectsAndDatasets } from "./projects-datasets.js";
import { addExperiments } from "./experiments.js";
import { addTraining } from "./training.js";
import { addLearning } from "./learning.js";
import { Empty } from "./common.js";
import {
  OPENPOND_APP_MCP_SCOPES,
  OpenPondMcpAuthorizationError,
  type AddTool,
  type OpenPondMcpOptions,
  type ToolDefinition,
  type OpenPondMcpScope,
} from "./types.js";
export { OPENPOND_APP_MCP_SCOPES, OpenPondMcpAuthorizationError } from "./types.js";
export type {
  OpenPondMcpContext,
  OpenPondMcpOptions,
  OpenPondMcpScope,
  OpenPondMcpStructuredResult,
} from "./types.js";

function jsonSchema(schema: z.ZodType): Tool["inputSchema"] {
  return z.toJSONSchema(schema, {
    unrepresentable: "any",
    io: "input",
    reused: "ref",
  }) as Tool["inputSchema"];
}
const MAXIMUM_DISCOVERY_BYTES = 1_048_576;
export function createOpenPondMcpServer(options: OpenPondMcpOptions) {
  const clients = createClients(options);
  const definitions: ToolDefinition[] = [];
  const add: AddTool = (name, description, input, effect, run, config = {}) => {
    definitions.push({
      name,
      description,
      input,
      effect,
      scopes: config.scopes ?? [
        effect === "read" ? "app:read" : (`app:${effect}` as OpenPondMcpScope),
      ],
      run: run as ToolDefinition["run"],
      output: config.output,
      wireOutput: config.wireOutput,
      idempotent: config.idempotent ?? effect === "read",
    });
  };
  add(
    "connection_context",
    "Verify this connection's account, fixed workspace and granted capabilities without running paid work.",
    Empty,
    "read",
    async () => ({
      userId: options.context.userId,
      teamId: options.context.teamId,
      scopes: options.context.scopes.filter((v) =>
        OPENPOND_APP_MCP_SCOPES.includes(v as OpenPondMcpScope),
      ),
    }),
  );
  addProjectsAndDatasets(add, clients);
  addExperiments(add, clients);
  addTraining(add, clients, options.context.teamId);
  addLearning(add, clients);
  const names = new Set(definitions.map((v) => v.name));
  if (names.size !== definitions.length) throw new Error("Duplicate OpenPond MCP tool name.");
  const server = new Server(
    { name: "openpond", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tools operate only in the connected OpenPond workspace. Read exact revisions and immutable references before mutation. Reuse accepted operation IDs after uncertain responses; never replace them to retry paid work. Ponder is model training. Local files, shells, Git and compute administration are outside this connection.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    await options.context.authorize([]);
    const visible = definitions
      .filter((v) => v.scopes.every((scope) => options.context.scopes.includes(scope)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const cursor = request.params?.cursor;
    const after = cursor === undefined ? -1 : visible.findIndex((v) => v.name === cursor);
    if (cursor !== undefined && after === -1)
      throw new McpError(ErrorCode.InvalidParams, "Invalid tool discovery cursor.");
    const candidates = visible.slice(after + 1);
    const tools: Tool[] = [];
    const envelopeBytes =
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: extra.requestId,
          result: null,
        }),
      ).byteLength - 4;
    const maximumResultBytes = MAXIMUM_DISCOVERY_BYTES - Math.max(1_024, envelopeBytes);
    let bytes = new TextEncoder().encode(JSON.stringify({ tools: [] })).byteLength;
    for (const [index, v] of candidates.entries()) {
      const tool: Tool = {
        name: v.name,
        description: v.description,
        inputSchema: jsonSchema(v.input),
        outputSchema:
          (v.wireOutput ?? v.output)
            ? jsonSchema(z.object({ result: (v.wireOutput ?? v.output)! }))
            : { type: "object" as const, properties: { result: {} }, required: ["result"] },
        annotations: {
          readOnlyHint: v.effect === "read",
          destructiveHint: v.effect !== "read",
          idempotentHint: v.idempotent,
          openWorldHint: true,
        },
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: v.scopes }],
          "openpond/effect": v.effect,
        },
      };
      const size = new TextEncoder().encode(JSON.stringify(tool)).byteLength;
      const nextBytes = bytes + size + (tools.length ? 1 : 0);
      // Reserve RPC overhead and include the result envelope, array separators
      // and continuation cursor; pagination never depends on a tool-count cap.
      const cursorBytes =
        index < candidates.length - 1
          ? new TextEncoder().encode(JSON.stringify({ nextCursor: v.name })).byteLength - 1
          : 0;
      if (nextBytes + cursorBytes > maximumResultBytes) {
        if (!tools.length)
          throw new McpError(
            ErrorCode.InternalError,
            "Tool discovery schema exceeds the 1 MiB response budget.",
          );
        break;
      }
      tools.push(tool);
      bytes = nextBytes;
    }
    return {
      tools,
      ...(tools.length < candidates.length ? { nextCursor: tools.at(-1)!.name } : {}),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = definitions.find((v) => v.name === request.params.name);
    if (!tool) throw new Error("Unknown OpenPond tool.");
    try {
      if (!tool.scopes.every((scope) => options.context.scopes.includes(scope)))
        throw new OpenPondMcpAuthorizationError("insufficient_scope", tool.scopes);
      await options.context.authorize(tool.scopes);
      const input = tool.input.parse(request.params.arguments ?? {});
      const result = await tool.run(input as never);
      if (tool.output) tool.output.parse(result);
      const structuredContent = JSON.parse(JSON.stringify({ result })) as Record<string, unknown>;
      const text = JSON.stringify(structuredContent);
      if (new TextEncoder().encode(text).byteLength > (options.maximumResultBytes ?? 2_097_152))
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: "result_too_large",
                message:
                  "Use a smaller page or inspect the retained resource in Console. No evidence was truncated.",
              }),
            },
          ],
        };
      return { structuredContent, content: [{ type: "text" as const, text }] };
    } catch (error) {
      if (error instanceof OpenPondMcpAuthorizationError) {
        const scopes = error.requiredScopes.length ? error.requiredScopes : tool.scopes;
        const challenge = options.context.authorizationChallenge?.(error.code, scopes);
        return {
          isError: true,
          ...(challenge ? { _meta: { "mcp/www_authenticate": [challenge] } } : {}),
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: error.code,
                requiredScopes: scopes,
                message:
                  "Reauthorize this OpenPond connection with the required workspace permissions.",
              }),
            },
          ],
        };
      }
      const known = error as {
        code?: unknown;
        status?: unknown;
        retryable?: unknown;
        requestId?: unknown;
      };
      const code =
        error instanceof z.ZodError
          ? "invalid_input_or_response"
          : typeof known.code === "string"
            ? known.code
            : "operation_failed";
      // Service errors may contain private provider diagnostics. Stable public
      // codes and recovery identifiers are returned without raw exception text.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              code,
              status: typeof known.status === "number" ? known.status : undefined,
              retryable: known.retryable === true,
              requestId: typeof known.requestId === "string" ? known.requestId : undefined,
              message:
                "OpenPond could not complete this operation. Inspect the current resource/operation identity before retrying.",
            }),
          },
        ],
      };
    }
  });
  return server;
}

/** One stateless Streamable HTTP transport per request. Accepted work belongs to
 * the service, so disconnecting cannot cancel or duplicate a durable operation. */
export async function handleOpenPondMcpRequest(
  request: Request,
  options: OpenPondMcpOptions,
): Promise<Response> {
  const server = createOpenPondMcpServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
