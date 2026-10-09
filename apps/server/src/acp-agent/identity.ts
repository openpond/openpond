import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { loadOpenPondAccountContext, streamOpChatChatCompletion, type HostedChatTurnInput, type RuntimeAccountContext } from "@openpond/runtime";
import { withOpenPondHome } from "@openpond/persistence";
import type { OpenPondAppServerOptions } from "../app-server-runtime.js";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function workspaceRoot(cwd: string, additionalDirectories?: string[]): Promise<string> {
  if (!path.isAbsolute(cwd) || additionalDirectories?.length) throw RequestError.invalidParams(undefined, "Supply one absolute workspace directory; additional roots are not supported.");
  try {
    const resolved = await realpath(cwd);
    if (!(await stat(resolved)).isDirectory()) throw new Error();
    return resolved;
  } catch { throw RequestError.invalidParams(undefined, "Workspace directory does not exist."); }
}

/** Tokens stay at their existing credential owner; only a non-secret account identity is persisted. */
export class AcpAccount {
  constructor(readonly home: string) {}

  async context(): Promise<RuntimeAccountContext> {
    const context = await withOpenPondHome(this.home, () => loadOpenPondAccountContext(process.env.OPENPOND_ACCOUNT, process.env.OPENPOND_BASE_URL));
    if (!context.token || !context.account) throw RequestError.authRequired(undefined, "Run openpond acp --login with the same --home/account options, then reconnect.");
    return context;
  }

  async scope(): Promise<string> {
    const context = await this.context();
    return fingerprint({ home: this.home, account: context.account!.handle, api: context.apiBaseUrl, chat: context.chatApiBaseUrl });
  }

  stream: NonNullable<OpenPondAppServerOptions["streamOpenPondHostedChatTurn"]> = async function* (this: AcpAccount, input: HostedChatTurnInput) {
    const context = await this.context();
    yield* streamOpChatChatCompletion({ ...input, apiBaseUrl: context.chatApiBaseUrl, token: context.token!, model: input.model || "openpond-chat" });
  }.bind(this);

  async streamForScope(expected: unknown): Promise<NonNullable<OpenPondAppServerOptions["streamOpenPondHostedChatTurn"]>> {
    const context = await this.context();
    const actual = fingerprint({ home: this.home, account: context.account!.handle, api: context.apiBaseUrl, chat: context.chatApiBaseUrl });
    if (actual !== expected) throw RequestError.invalidRequest(undefined, "The session account or model route changed. Reconnect with the original account or start a new session.");
    // Capture credentials for this individual model round. A concurrent settings
    // update cannot redirect an already validated request to another account.
    return async function* (input) { yield* streamOpChatChatCompletion({ ...input, apiBaseUrl: context.chatApiBaseUrl, token: context.token!, model: input.model || "openpond-chat" }); };
  }

  async models(): Promise<Array<{ id: string; name: string }>> {
    const context = await this.context();
    const endpoint = `${context.chatApiBaseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${context.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw RequestError.authRequired(undefined, `OpenPond model route is unavailable (HTTP ${response.status}). Check login and account access.`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const ids = [...new Set((body.data ?? []).flatMap(model => typeof model.id === "string" && model.id.trim() ? [model.id] : []))];
    if (!ids.length) throw RequestError.invalidRequest(undefined, "OpenPond model route returned no usable models.");
    return ids.map(id => ({ id, name: id === "openpond-chat" ? "OpenPond Chat" : id }));
  }
}
