import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  OpenPondOrganization,
  OpenPondOrganizationCreateInput,
  OpenPondOrganizationMcpGenerateInput,
  OpenPondOrganizationMcpServer,
  OpenPondOrganizationMember,
  OpenPondOrganizationMemberUpsertInput,
  OpenPondOrganizationRole,
  OpenPondOrganizationUpdateInput,
} from "../sandbox/types/index";
import {
  parseBooleanOption,
  parseCsvOption,
  parseIntegerOption,
  parseJsonOption,
  resolveSandboxClient,
} from "./common";

export function formatOrganizationLine(
  organization: OpenPondOrganization
): string {
  return [
    organization.slug,
    `team=${organization.teamId}`,
    `role=${organization.role}`,
    `status=${organization.status}`,
    organization.displayName,
  ].join("  ");
}

export function formatOrganizationMemberLine(
  member: OpenPondOrganizationMember
): string {
  return [
    member.email ?? member.userId,
    `user=${member.userId}`,
    `role=${member.role}`,
    member.createdAt,
  ].join("  ");
}

export function formatOrganizationMcpServerLine(
  server: OpenPondOrganizationMcpServer | null
): string {
  if (!server) return "no mcp server configured";
  return [
    server.slug,
    `team=${server.teamId}`,
    `status=${server.status}`,
    `tools=${server.toolset.join(",") || "-"}`,
    server.resourceUrl,
  ].join("  ");
}

export type McpProbeHttpResult = {
  url: string;
  status: number;
  ok: boolean;
  headers: {
    contentType: string | null;
    location: string | null;
    wwwAuthenticate: string | null;
  };
  body: unknown;
};

export const DEFAULT_MCP_AUTHORIZE_SCOPES = [
  "estimate.read",
  "estimate.write",
  "estimate.execute",
  "artifacts.read",
  "artifacts.write",
] as const;

export type McpOAuthTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type McpOAuthCallbackListener = {
  close: () => Promise<void>;
  redirectUri: string;
  waitForCallback: () => Promise<{ code: string; state: string }>;
};

export function normalizeMcpResourceUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed) {
    throw new Error("MCP resource URL must be non-empty");
  }
  const parsed = new URL(trimmed);
  return parsed.toString().replace(/\/$/, "");
}

export function resolveMcpProbeResourceUrl(
  server: OpenPondOrganizationMcpServer | null,
  options: Record<string, string | boolean>
): string {
  const explicit =
    typeof options.resourceUrl === "string" && options.resourceUrl.trim()
      ? options.resourceUrl.trim()
      : typeof options.url === "string" && options.url.trim()
      ? options.url.trim()
      : "";
  if (explicit) {
    return normalizeMcpResourceUrl(explicit);
  }
  if (!server?.resourceUrl) {
    throw new Error(
      "organization does not have an MCP server; run organizations mcp-generate first"
    );
  }
  return normalizeMcpResourceUrl(server.resourceUrl);
}

export function resolveMcpProbeOrigin(
  resourceUrl: string,
  options: Record<string, string | boolean>
): string {
  const explicit =
    typeof options.origin === "string" && options.origin.trim()
      ? options.origin.trim()
      : "";
  if (explicit) {
    return normalizeMcpResourceUrl(explicit);
  }
  return new URL(resourceUrl).origin;
}

export function randomOauthToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function buildMcpOauthPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function parseMcpOAuthScopes(
  options: Record<string, string | boolean>
): string[] {
  const raw =
    typeof options.scope === "string" && options.scope.trim()
      ? options.scope
      : typeof options.scopes === "string" && options.scopes.trim()
      ? options.scopes
      : "";
  if (!raw) {
    return [...DEFAULT_MCP_AUTHORIZE_SCOPES];
  }
  const scopes = raw
    .split(/[,\s]+/g)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    throw new Error("scope must include at least one OAuth scope");
  }
  return scopes;
}

export function resolveMcpOAuthClientId(
  options: Record<string, string | boolean>
): string {
  const value =
    typeof options.clientId === "string" && options.clientId.trim()
      ? options.clientId.trim()
      : "openpond-code-mcp-proof";
  if (value === "true") {
    throw new Error("client-id must be a non-empty value");
  }
  return value;
}

export function resolveMcpOAuthTimeoutMs(
  options: Record<string, string | boolean>
): number {
  const timeoutSeconds =
    parseIntegerOption(options.timeoutSeconds, "timeout-seconds") ??
    parseIntegerOption(options.timeout, "timeout") ??
    180;
  if (timeoutSeconds <= 0) {
    throw new Error("timeout must be greater than zero");
  }
  return timeoutSeconds * 1000;
}

export function resolveMcpOAuthCallbackPort(
  options: Record<string, string | boolean>
): number {
  const port = parseIntegerOption(options.callbackPort, "callback-port") ?? 0;
  if (port < 0 || port > 65535) {
    throw new Error("callback-port must be between 0 and 65535");
  }
  return port;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startMcpOAuthCallbackListener(input: {
  expectedState: string;
  port: number;
  timeoutMs: number;
}): Promise<McpOAuthCallbackListener> {
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  let resolveCallback:
    | ((value: { code: string; state: string }) => void)
    | null = null;
  let rejectCallback: ((error: Error) => void) | null = null;
  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    }
  );

  const settle = (
    response: ServerResponse,
    status: number,
    body: string,
    result?: { code: string; state: string },
    error?: Error
  ) => {
    if (settled) {
      response.writeHead(204).end();
      return;
    }
    settled = true;
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body);
    if (timeout) clearTimeout(timeout);
    if (result) {
      resolveCallback?.(result);
    } else {
      rejectCallback?.(error ?? new Error("oauth_callback_failed"));
    }
  };

  const server = createServer((request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (state !== input.expectedState) {
      settle(
        response,
        400,
        "<!doctype html><title>OpenPond OAuth failed</title><p>State mismatch. Return to the terminal and retry.</p>",
        undefined,
        new Error("oauth_state_mismatch")
      );
      return;
    }
    if (error) {
      settle(
        response,
        400,
        "<!doctype html><title>OpenPond OAuth denied</title><p>Authorization was not completed. Return to the terminal.</p>",
        undefined,
        new Error(`oauth_authorization_failed:${error}`)
      );
      return;
    }
    if (!code) {
      settle(
        response,
        400,
        "<!doctype html><title>OpenPond OAuth failed</title><p>Missing authorization code. Return to the terminal and retry.</p>",
        undefined,
        new Error("oauth_code_missing")
      );
      return;
    }
    settle(
      response,
      200,
      "<!doctype html><title>OpenPond OAuth complete</title><p>Authorization complete. You can return to the terminal.</p>",
      { code, state }
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.port, "127.0.0.1");
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    await closeServer(server);
    throw new Error("oauth_callback_listener_failed");
  }

  timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCallback?.(new Error("oauth_callback_timeout"));
    }
  }, input.timeoutMs);

  return {
    close: async () => {
      if (timeout) clearTimeout(timeout);
      await closeServer(server).catch(() => {});
    },
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCallback: () => callbackPromise,
  };
}

export function openUrlWithSystemBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  // Detached OS handoff; there is no captured command output to bound.
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function buildMcpOAuthAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resourceUrl: string;
  scopes: string[];
  state: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resourceUrl);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeMcpOAuthAuthorizationCode(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  origin: string;
  redirectUri: string;
}): Promise<McpOAuthTokenResponse> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("code", input.code);
  params.set("code_verifier", input.codeVerifier);

  const response = await fetch(`${input.origin}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const body = await readMcpProbeBody(response);
  if (!response.ok) {
    throw new Error(
      `oauth_token_exchange_failed:${response.status}:${JSON.stringify(body)}`
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("oauth_token_exchange_invalid_response");
  }
  const token = body as Record<string, unknown>;
  if (typeof token.access_token !== "string" || !token.access_token.trim()) {
    throw new Error("oauth_token_exchange_missing_access_token");
  }
  return {
    access_token: token.access_token,
    ...(typeof token.expires_in === "number"
      ? { expires_in: token.expires_in }
      : {}),
    ...(typeof token.refresh_token === "string"
      ? { refresh_token: token.refresh_token }
      : {}),
    ...(typeof token.scope === "string" ? { scope: token.scope } : {}),
    ...(typeof token.token_type === "string"
      ? { token_type: token.token_type }
      : {}),
  };
}

export async function readMcpProbeBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.toLowerCase().includes("application/json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

export async function fetchMcpProbe(
  url: string,
  init: RequestInit = {}
): Promise<McpProbeHttpResult> {
  const response = await fetch(url, init);
  return {
    url,
    status: response.status,
    ok: response.ok,
    headers: {
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      wwwAuthenticate: response.headers.get("www-authenticate"),
    },
    body: await readMcpProbeBody(response),
  };
}

export function buildMcpJsonRpcRequest(
  id: number,
  method: string,
  params?: Record<string, unknown>
): Record<string, unknown> {
  return params
    ? { jsonrpc: "2.0", id, method, params }
    : { jsonrpc: "2.0", id, method };
}

export function parseMcpToolArguments(
  options: Record<string, string | boolean>
): Record<string, unknown> {
  const raw =
    typeof options.arguments === "string" && options.arguments.trim()
      ? options.arguments
      : typeof options.args === "string" && options.args.trim()
      ? options.args
      : "";
  if (!raw) {
    return {};
  }
  const parsed = parseJsonOption(raw, "arguments");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function postMcpJsonRpcProbe(input: {
  resourceUrl: string;
  id: number;
  method: string;
  params?: Record<string, unknown>;
  accessToken?: string;
}): Promise<McpProbeHttpResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (input.accessToken) {
    headers.authorization = `Bearer ${input.accessToken}`;
  }
  return fetchMcpProbe(input.resourceUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(
      buildMcpJsonRpcRequest(input.id, input.method, input.params)
    ),
  });
}

export async function probeOrganizationMcp(input: {
  resourceUrl: string;
  origin: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  accessToken?: string;
}): Promise<Record<string, unknown>> {
  const resourceUrl = normalizeMcpResourceUrl(input.resourceUrl);
  const origin = normalizeMcpResourceUrl(input.origin);
  const protectedResourceUrl = `${resourceUrl}/.well-known/oauth-protected-resource`;
  const authorizationServerUrl = `${origin}/.well-known/oauth-authorization-server`;
  const [
    protectedResource,
    authorizationServer,
    directGetChallenge,
    initialize,
    toolsList,
    unauthenticatedToolCall,
    authenticatedToolCall,
  ] = await Promise.all([
    fetchMcpProbe(protectedResourceUrl),
    fetchMcpProbe(authorizationServerUrl),
    fetchMcpProbe(resourceUrl),
    postMcpJsonRpcProbe({
      resourceUrl,
      id: 1,
      method: "initialize",
    }),
    postMcpJsonRpcProbe({
      resourceUrl,
      id: 2,
      method: "tools/list",
    }),
    postMcpJsonRpcProbe({
      resourceUrl,
      id: 3,
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.toolArguments,
      },
    }),
    input.accessToken
      ? postMcpJsonRpcProbe({
          resourceUrl,
          id: 4,
          method: "tools/call",
          params: {
            name: input.toolName,
            arguments: input.toolArguments,
          },
          accessToken: input.accessToken,
        })
      : Promise.resolve(null),
  ]);

  return {
    resourceUrl,
    origin,
    protectedResource,
    authorizationServer,
    directGetChallenge,
    initialize,
    toolsList,
    unauthenticatedToolCall,
    ...(authenticatedToolCall ? { authenticatedToolCall } : {}),
  };
}

export function parseOrganizationRole(
  value: string | boolean | undefined
): OpenPondOrganizationRole {
  const role = typeof value === "string" ? value.trim() : "";
  if (role === "owner" || role === "admin" || role === "member") {
    return role;
  }
  throw new Error("role must be owner, admin, or member");
}

export function buildOrganizationCreateInput(
  options: Record<string, string | boolean>
): OpenPondOrganizationCreateInput {
  const displayName =
    typeof options.displayName === "string" && options.displayName.trim()
      ? options.displayName.trim()
      : typeof options.name === "string" && options.name.trim()
      ? options.name.trim()
      : "";
  if (!displayName) {
    throw new Error(
      "usage: organizations create --name <name> [--slug <slug>]"
    );
  }
  return {
    displayName,
    ...(typeof options.slug === "string" && options.slug.trim()
      ? { slug: options.slug.trim() }
      : {}),
    ...(typeof options.primaryContactEmail === "string" &&
    options.primaryContactEmail.trim()
      ? { primaryContactEmail: options.primaryContactEmail.trim() }
      : {}),
    ...(typeof options.customDomain === "string" && options.customDomain.trim()
      ? { customDomain: options.customDomain.trim() }
      : {}),
  };
}

export function buildOrganizationUpdateInput(
  options: Record<string, string | boolean>
): OpenPondOrganizationUpdateInput {
  const input: OpenPondOrganizationUpdateInput = {};
  const displayName =
    typeof options.displayName === "string" && options.displayName.trim()
      ? options.displayName.trim()
      : typeof options.name === "string" && options.name.trim()
      ? options.name.trim()
      : "";
  if (displayName) input.displayName = displayName;
  if (typeof options.slug === "string" && options.slug.trim()) {
    input.slug = options.slug.trim();
  }
  if (typeof options.primaryContactEmail === "string") {
    input.primaryContactEmail = options.primaryContactEmail.trim() || null;
  }
  if (typeof options.customDomain === "string") {
    input.customDomain = options.customDomain.trim() || null;
  }
  if (typeof options.status === "string" && options.status.trim()) {
    const status = options.status.trim();
    if (status !== "active" && status !== "disabled" && status !== "archived") {
      throw new Error("status must be active, disabled, or archived");
    }
    input.status = status;
  }
  if (Object.keys(input).length === 0) {
    throw new Error("organizations update requires at least one changed field");
  }
  return input;
}

export function buildOrganizationMemberInput(
  options: Record<string, string | boolean>
): OpenPondOrganizationMemberUpsertInput {
  const email = typeof options.email === "string" ? options.email.trim() : "";
  if (!email) {
    throw new Error(
      "usage: organizations member-upsert <slug> --email <email> --role <role>"
    );
  }
  return {
    email,
    role: parseOrganizationRole(options.role),
  };
}

export function buildOrganizationMcpGenerateInput(
  options: Record<string, string | boolean>
): OpenPondOrganizationMcpGenerateInput {
  return {
    ...(typeof options.origin === "string" && options.origin.trim()
      ? { origin: options.origin.trim() }
      : {}),
    ...(typeof options.toolset === "string" && options.toolset.trim()
      ? { toolset: parseCsvOption(options.toolset) }
      : {}),
  };
}

export async function runOrganizationsCommand(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "list";
  const client = await resolveSandboxClient(options);
  const outputJson = parseBooleanOption(options.json);

  if (subcommand === "list") {
    const organizations = await client.listOrganizations();
    if (outputJson) {
      console.log(JSON.stringify({ organizations }, null, 2));
      return;
    }
    if (organizations.length === 0) {
      console.log("no organizations found");
      return;
    }
    for (const organization of organizations) {
      console.log(formatOrganizationLine(organization));
    }
    return;
  }

  if (subcommand === "create") {
    const organization = await client.createOrganization(
      buildOrganizationCreateInput(options)
    );
    console.log(JSON.stringify({ organization }, null, 2));
    return;
  }

  if (subcommand === "get") {
    const slug = rest[1];
    if (!slug) {
      throw new Error("usage: organizations get <slug>");
    }
    const organization = await client.getOrganization(slug);
    console.log(JSON.stringify({ organization }, null, 2));
    return;
  }

  if (subcommand === "update") {
    const slug = rest[1];
    if (!slug) {
      throw new Error("usage: organizations update <slug> [--name <name>]");
    }
    const organization = await client.updateOrganization(
      slug,
      buildOrganizationUpdateInput(options)
    );
    console.log(JSON.stringify({ organization }, null, 2));
    return;
  }

  if (subcommand === "members" || subcommand === "member-list") {
    const slug = rest[1];
    if (!slug) {
      throw new Error("usage: organizations members <slug>");
    }
    const members = await client.listOrganizationMembers(slug);
    if (outputJson) {
      console.log(JSON.stringify({ members }, null, 2));
      return;
    }
    if (members.length === 0) {
      console.log("no organization members found");
      return;
    }
    for (const member of members) {
      console.log(formatOrganizationMemberLine(member));
    }
    return;
  }

  if (subcommand === "member-upsert" || subcommand === "member-add") {
    const slug = rest[1];
    if (!slug) {
      throw new Error(
        "usage: organizations member-upsert <slug> --email <email> --role <role>"
      );
    }
    const member = await client.upsertOrganizationMember(
      slug,
      buildOrganizationMemberInput(options)
    );
    console.log(JSON.stringify({ member }, null, 2));
    return;
  }

  if (subcommand === "mcp-get" || subcommand === "mcp-server") {
    const slug = rest[1];
    if (!slug) {
      throw new Error("usage: organizations mcp-get <slug>");
    }
    const mcpServer = await client.getOrganizationMcpServer(slug);
    if (outputJson) {
      console.log(JSON.stringify({ mcpServer }, null, 2));
      return;
    }
    console.log(formatOrganizationMcpServerLine(mcpServer));
    return;
  }

  if (subcommand === "mcp-generate") {
    const slug = rest[1];
    if (!slug) {
      throw new Error(
        "usage: organizations mcp-generate <slug> [--origin <url>]"
      );
    }
    const mcpServer = await client.generateOrganizationMcpServer(
      slug,
      buildOrganizationMcpGenerateInput(options)
    );
    console.log(JSON.stringify({ mcpServer }, null, 2));
    return;
  }

  if (subcommand === "mcp-probe" || subcommand === "mcp-inspect") {
    const slug = rest[1];
    if (!slug) {
      throw new Error(
        "usage: organizations mcp-probe <slug> [--origin <url>] [--tool <name>] [--arguments <json>] [--access-token <token>]"
      );
    }
    const mcpServer = await client.getOrganizationMcpServer(slug);
    const resourceUrl = resolveMcpProbeResourceUrl(mcpServer, options);
    const origin = resolveMcpProbeOrigin(resourceUrl, options);
    const toolName =
      typeof options.tool === "string" && options.tool.trim()
        ? options.tool.trim()
        : typeof options.toolName === "string" && options.toolName.trim()
        ? options.toolName.trim()
        : "estimate_search_history";
    const toolArguments = parseMcpToolArguments(options);
    const accessToken =
      typeof options.accessToken === "string" && options.accessToken.trim()
        ? options.accessToken.trim()
        : "";
    const probe = await probeOrganizationMcp({
      resourceUrl,
      origin,
      toolName,
      toolArguments,
      ...(accessToken ? { accessToken } : {}),
    });
    console.log(JSON.stringify({ mcpServer, probe }, null, 2));
    return;
  }

  if (subcommand === "mcp-authorize" || subcommand === "mcp-oauth") {
    const slug = rest[1];
    if (!slug) {
      throw new Error(
        "usage: organizations mcp-authorize <slug> [--origin <url>] [--scope <csv|space>] [--tool <name>] [--arguments <json>] [--open]"
      );
    }
    const mcpServer = await client.getOrganizationMcpServer(slug);
    const resourceUrl = resolveMcpProbeResourceUrl(mcpServer, options);
    const origin = resolveMcpProbeOrigin(resourceUrl, options);
    const clientId = resolveMcpOAuthClientId(options);
    const scopes = parseMcpOAuthScopes(options);
    const state = randomOauthToken(18);
    const codeVerifier = randomOauthToken(48);
    const codeChallenge = buildMcpOauthPkceChallenge(codeVerifier);
    const callback = await startMcpOAuthCallbackListener({
      expectedState: state,
      port: resolveMcpOAuthCallbackPort(options),
      timeoutMs: resolveMcpOAuthTimeoutMs(options),
    });
    const authorizationUrl = buildMcpOAuthAuthorizeUrl({
      authorizationEndpoint: `${origin}/oauth/authorize`,
      clientId,
      codeChallenge,
      redirectUri: callback.redirectUri,
      resourceUrl,
      scopes,
      state,
    });
    console.error(
      "Open this URL to authorize the organization MCP connection:"
    );
    console.error(authorizationUrl);
    console.error(`Waiting for OAuth callback on ${callback.redirectUri}`);
    if (parseBooleanOption(options.open)) {
      try {
        openUrlWithSystemBrowser(authorizationUrl);
      } catch (error) {
        console.error(
          `Unable to open a browser automatically: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    try {
      const callbackResult = await callback.waitForCallback();
      const token = await exchangeMcpOAuthAuthorizationCode({
        clientId,
        code: callbackResult.code,
        codeVerifier,
        origin,
        redirectUri: callback.redirectUri,
      });
      const toolName =
        typeof options.tool === "string" && options.tool.trim()
          ? options.tool.trim()
          : typeof options.toolName === "string" && options.toolName.trim()
          ? options.toolName.trim()
          : "estimate_search_history";
      const toolArguments = parseMcpToolArguments(options);
      const probe = await probeOrganizationMcp({
        accessToken: token.access_token,
        origin,
        resourceUrl,
        toolArguments,
        toolName,
      });
      const printToken = parseBooleanOption(options.printToken);
      console.log(
        JSON.stringify(
          {
            mcpServer,
            oauth: {
              accessTokenReceived: true,
              clientId,
              expiresIn: token.expires_in ?? null,
              refreshTokenReceived: Boolean(token.refresh_token),
              scope: token.scope ?? scopes.join(" "),
              tokenType: token.token_type ?? "Bearer",
              ...(printToken
                ? {
                    accessToken: token.access_token,
                    refreshToken: token.refresh_token ?? null,
                  }
                : {}),
            },
            probe,
          },
          null,
          2
        )
      );
    } finally {
      await callback.close();
    }
    return;
  }

  if (
    subcommand === "mcp-rotate" ||
    subcommand === "mcp-disable" ||
    subcommand === "mcp-enable"
  ) {
    const slug = rest[1];
    if (!slug) {
      throw new Error(`usage: organizations ${subcommand} <slug>`);
    }
    const mcpServer =
      subcommand === "mcp-rotate"
        ? await client.rotateOrganizationMcpServer(slug)
        : subcommand === "mcp-disable"
        ? await client.disableOrganizationMcpServer(slug)
        : await client.enableOrganizationMcpServer(slug);
    console.log(JSON.stringify({ mcpServer }, null, 2));
    return;
  }

  throw new Error(
    "usage: organizations <list|create|get|update|members|member-upsert|mcp-get|mcp-generate|mcp-probe|mcp-authorize|mcp-rotate|mcp-disable|mcp-enable> [args]"
  );
}
