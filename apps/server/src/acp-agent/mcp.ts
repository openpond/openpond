import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { fingerprint } from "./identity.js";
import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";

/** Client-supplied MCP launch environment and headers never enter persisted session metadata. */
export class SessionMcp {
  readonly tools: ModelToolDefinition[] = [];
  private readonly clients: Array<{ client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport }> = [];
  readonly identity: string;
  constructor(readonly servers: McpServer[], readonly cwd: string) {
    this.identity = fingerprint(servers);
  }

  async connect(): Promise<void> {
    if (this.servers.length > 16 || new Set(this.servers.map(server => server.name)).size !== this.servers.length) throw RequestError.invalidParams(undefined, "MCP server names must be unique; maximum 16 servers.");
    try {
      for (const server of this.servers) {
        if ("type" in server && server.type !== "http") throw RequestError.invalidParams(undefined, "Only stdio and HTTP MCP transports are supported.");
        const client = new Client({ name: "openpond-acp", version: "1.0.0" });
        const transport = "type" in server
          ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } })
          : new StdioClientTransport({ command: server.command, args: server.args, cwd: this.cwd, env: { ...getDefaultEnvironment(), ...Object.fromEntries(server.env.map(variable => [variable.name, variable.value])) }, stderr: "inherit" });
        this.clients.push({ client, transport });
        await client.connect(transport, { timeout: 15_000 });
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
          for (const tool of page.tools) {
            if (this.tools.length >= 256) throw RequestError.invalidParams(undefined, "MCP tool catalog exceeds 256 tools.");
            const name = `acp_mcp_${fingerprint([server.name, tool.name]).slice(0, 24)}`;
            if (this.tools.some(existing => existing.name === name)) throw RequestError.invalidParams(undefined, "Duplicate MCP tool identity.");
            this.tools.push({ name, description: `${server.name}: ${tool.name}. ${tool.description ?? ""}`, parameters: tool.inputSchema,
              execute: async context => {
                const result = await client.callTool({ name: tool.name, arguments: context.args }, undefined, { signal: context.signal, timeout: 60_000 });
                const contentText = JSON.stringify(result);
                if (Buffer.byteLength(contentText) > 128 * 1024) throw new Error("MCP tool result exceeds 128 KiB.");
                return { toolCallId: context.callId, name, ok: !result.isError, contentText, data: result };
              },
            });
          }
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw RequestError.invalidParams(undefined, "MCP catalog repeats a pagination cursor.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
    } catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.splice(0).map(async ({ client, transport }) => {
      try {
        if (transport instanceof StreamableHTTPClientTransport) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([transport.terminateSession(), new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
          } finally { if (timer) clearTimeout(timer); }
        }
      } finally { await client.close(); }
    }));
    this.tools.length = 0;
  }
}
