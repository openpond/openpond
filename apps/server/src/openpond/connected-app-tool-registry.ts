import {
  CONNECTED_APP_PROVIDER_TOOL_NAMES,
  connectedAppBundleByProvider,
  connectedAppProviderOperationById,
  normalizeConnectedAppProviderFamilyId,
  validateConnectedAppProviderOperationRequest,
  type ConnectedAppProviderToolName,
  type ConnectedAppProviderToolOperation,
  type ConnectedAppToolCallRequest,
  type ConnectedAppToolCallResponse,
  type ConnectedAppProviderFamilyId,
} from "@openpond/contracts";
import type { ResolvedConnectedAppContext } from "./connected-app-context.js";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";

export { CONNECTED_APP_PROVIDER_TOOL_NAMES };

export type ConnectedAppToolExecutionRequest = ConnectedAppToolCallRequest;
export type ConnectedAppToolExecutionResult = ConnectedAppToolCallResponse;

export type ConnectedAppToolExecutor = (
  request: ConnectedAppToolExecutionRequest,
  options?: { signal?: AbortSignal },
) => Promise<ConnectedAppToolExecutionResult>;

export function connectedAppProviderToolNames(
  context: Pick<ResolvedConnectedAppContext, "capabilities" | "provider">,
): string[] {
  if (context.provider === "mcp") return [];
  const names: ConnectedAppProviderToolName[] = [];
  if (capabilitiesForOperation(context, "read").length > 0) {
    names.push("connected_app_search", "connected_app_read");
  }
  if (capabilitiesForOperation(context, "write").length > 0) {
    names.push("connected_app_write");
  }
  return names;
}

export function createConnectedAppProviderModelToolDefinitions(deps: {
  connectedApps: ResolvedConnectedAppContext[];
  executeConnectedAppTool?: ConnectedAppToolExecutor;
}): ModelToolDefinition[] {
  const contexts = dedupeContexts(deps.connectedApps)
    .filter((context) => connectedAppProviderToolNames(context).length > 0)
    .sort((left, right) => left.label.localeCompare(right.label));
  if (contexts.length === 0) return [];

  const definitions: ModelToolDefinition[] = [];
  const searchableProviders = providersForTool(contexts, "connected_app_search");
  const readableProviders = providersForTool(contexts, "connected_app_read");
  const writableProviders = providersForTool(contexts, "connected_app_write");

  if (searchableProviders.length > 0) {
    definitions.push({
      name: "connected_app_search",
      description:
        "Search a server-validated connected app provider using only capabilities available in this turn. Returns provider refs suitable for connected_app_read or a follow-up write.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            enum: searchableProviders,
            description: "Connected app provider id from the Connected apps available in this turn list.",
          },
          query: {
            type: "string",
            minLength: 1,
            description: "Grounded provider search query.",
          },
          operation: {
            type: "string",
            minLength: 1,
            description:
              "Optional provider operation id from the loaded connected app instructions, such as google.drive.search, github.issue.search, x.search.posts, or x.mentions.search.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "Maximum result count.",
          },
          capabilityIds: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
            description: "Optional narrower read capability ids from the provider's listed capabilities.",
          },
        },
        required: ["provider", "query"],
      },
      execute: (context) =>
        executeConnectedAppToolDefinition({
          context,
          contexts,
          operation: "search",
          toolName: "connected_app_search",
          executeConnectedAppTool: deps.executeConnectedAppTool,
        }),
    });
  }

  if (readableProviders.length > 0) {
    definitions.push({
      name: "connected_app_read",
      description:
        "Read one grounded object from a server-validated connected app provider by stable provider ref.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            enum: readableProviders,
            description: "Connected app provider id from the Connected apps available in this turn list.",
          },
          ref: {
            type: "string",
            minLength: 1,
            description: "Stable provider ref returned by connected_app_search or supplied by the user.",
          },
          operation: {
            type: "string",
            minLength: 1,
            description:
              "Optional provider operation id from the loaded connected app instructions, such as google.docs.read, github.pull_request.read, x.profile.read, x.post.read, or x.mention.read.",
          },
          mode: {
            type: "string",
            enum: ["content", "metadata", "comments"],
            description: "Optional read mode.",
          },
          capabilityIds: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
            description: "Optional narrower read capability ids from the provider's listed capabilities.",
          },
        },
        required: ["provider", "ref"],
      },
      execute: (context) =>
        executeConnectedAppToolDefinition({
          context,
          contexts,
          operation: "read",
          toolName: "connected_app_read",
          executeConnectedAppTool: deps.executeConnectedAppTool,
        }),
    });
  }

  if (writableProviders.length > 0) {
    definitions.push({
      name: "connected_app_write",
      description:
        "Perform an explicitly requested write through a server-validated connected app provider. Use only after the user clearly requested the write target and content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            enum: writableProviders,
            description: "Connected app provider id from the Connected apps available in this turn list.",
          },
          operation: {
            type: "string",
            minLength: 1,
            description:
              "Provider operation id from the loaded connected app instructions, such as google.docs.update, github.issue.create, x.post.create, or x.reply.create.",
          },
          input: {
            type: "object",
            additionalProperties: true,
            description: "Provider-specific write input. Do not include OAuth tokens, cookies, or provider secrets.",
          },
          explicitUserIntent: {
            type: "string",
            minLength: 1,
            description: "Short summary of the user's explicit requested write target and content.",
          },
          capabilityIds: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
            description: "Optional narrower write capability ids from the provider's listed capabilities.",
          },
        },
        required: ["provider", "operation", "input", "explicitUserIntent"],
      },
      execute: (context) =>
        executeConnectedAppToolDefinition({
          context,
          contexts,
          operation: "write",
          toolName: "connected_app_write",
          executeConnectedAppTool: deps.executeConnectedAppTool,
        }),
    });
  }

  return definitions;
}

export function isConnectedAppProviderToolName(
  name: string,
): name is ConnectedAppProviderToolName {
  return (CONNECTED_APP_PROVIDER_TOOL_NAMES as readonly string[]).includes(name);
}

export function redactConnectedAppToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isConnectedAppProviderToolName(toolName)) return args;
  const redacted = redactSensitiveValue(args);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

async function executeConnectedAppToolDefinition(input: {
  context: ModelToolExecutionContext;
  contexts: ResolvedConnectedAppContext[];
  operation: ConnectedAppProviderToolOperation;
  toolName: ConnectedAppProviderToolName;
  executeConnectedAppTool?: ConnectedAppToolExecutor;
}): Promise<NativeModelToolResult> {
  const provider = normalizeConnectedAppProviderFamilyId(stringValue(input.context.args.provider));
  if (!provider) {
    return connectedAppToolFailure(input.context.callId, input.toolName, "Connected app provider is required.");
  }

  const connectedApp = input.contexts.find((context) => context.provider === provider);
  if (!connectedApp) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      `Connected app provider ${provider} is not available in this turn.`,
    );
  }

  const allowedCapabilities = capabilitiesForOperation(connectedApp, input.operation).map((capability) => capability.id);
  if (allowedCapabilities.length === 0) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      `Connected app provider ${provider} does not have ${input.operation} capabilities in this turn.`,
      { provider, operation: input.operation },
    );
  }

  const requestedCapabilities = stringArray(input.context.args.capabilityIds);
  const capabilityIds = requestedCapabilities.length > 0
    ? requestedCapabilities
    : inferredProviderOperationCapabilityIds({
      args: input.context.args,
      operation: input.operation,
      provider,
    }) ?? allowedCapabilities;
  const unauthorized = capabilityIds.filter((capabilityId) => !allowedCapabilities.includes(capabilityId));
  if (unauthorized.length > 0) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      `Capability ${unauthorized[0]} is not authorized for ${provider} in this turn.`,
      {
        provider,
        operation: input.operation,
        authorizedCapabilityIds: allowedCapabilities,
      },
    );
  }

  if (input.operation === "write" && !stringValue(input.context.args.explicitUserIntent)) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      "Connected app writes require explicitUserIntent describing the user's requested target and content.",
      { provider, operation: input.operation },
    );
  }

  const providerOperationValidation = validateConnectedAppProviderOperationRequest({
    provider,
    operation: input.operation,
    capabilityIds,
    args: input.context.args,
  });
  if (!providerOperationValidation.ok) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      providerOperationValidation.error,
      connectedAppResultMetadata(connectedApp, input.operation, capabilityIds),
    );
  }
  const redactedArgs = redactConnectedAppToolArguments(input.toolName, input.context.args);
  if (!input.executeConnectedAppTool) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      `Connected app connector execution is not configured for ${provider}. No provider API call was made.`,
      connectedAppResultMetadata(connectedApp, input.operation, capabilityIds),
    );
  }

  const result = await input.executeConnectedAppTool(
    {
      provider,
      operation: input.operation,
      toolName: input.toolName,
      sessionId: input.context.session.id,
      turnId: input.context.turnId,
      userPrompt: input.context.userPrompt,
      connectionIds: [...connectedApp.connectionIds],
      capabilityIds,
      args: redactedArgs,
    },
    { signal: input.context.signal },
  );
  const metadata = connectedAppResultMetadata(connectedApp, input.operation, capabilityIds);
  if (input.operation === "write" && result.ok && !hasWriteReadbackVerification(result.data)) {
    return connectedAppToolFailure(
      input.context.callId,
      input.toolName,
      `Connected app write for ${connectedApp.label} did not return required readback verification.`,
      {
        ...metadata,
        requiresReadbackVerification: true,
      },
    );
  }
  const redactedData = redactSensitiveValue(result.data);
  const output = connectedAppToolOutput({
    connectedAppLabel: connectedApp.label,
    data: redactedData,
    ok: result.ok,
    operation: input.operation,
    output: result.output,
  });
  return {
    toolCallId: input.context.callId,
    name: input.toolName,
    ok: result.ok,
    contentText: JSON.stringify(
      {
        ok: result.ok,
        action: input.toolName,
        output,
        data: {
          ...metadata,
          result: redactedData ?? null,
        },
      },
      null,
      2,
    ),
    data: {
      ...metadata,
      result: redactedData ?? null,
    },
  };
}

function inferredProviderOperationCapabilityIds(input: {
  args: Record<string, unknown>;
  operation: ConnectedAppProviderToolOperation;
  provider: ConnectedAppProviderFamilyId;
}): string[] | null {
  const providerOperation = connectedAppProviderOperationById(
    input.provider,
    stringValue(input.args.operation),
  );
  if (!providerOperation || providerOperation.operation !== input.operation) return null;
  return providerOperation.capabilityIds;
}

function connectedAppToolOutput(input: {
  connectedAppLabel: string;
  data: unknown;
  ok: boolean;
  operation: ConnectedAppProviderToolOperation;
  output: string | null | undefined;
}): string {
  const base = input.output ?? (input.ok
    ? `Completed ${input.operation} for ${input.connectedAppLabel}.`
    : `Connected app ${input.operation} failed for ${input.connectedAppLabel}.`);
  if (input.ok) return base;
  const providerError = connectedAppProviderErrorSummary(input.data);
  return providerError ? `${base} ${providerError}` : base;
}

function connectedAppProviderErrorSummary(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const record = data;
  const result = isRecord(record.result) ? record.result : null;
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  const httpStatus = numberValue(metadata?.httpStatus) ?? numberValue(result?.status);
  const title = stringValue(result?.title);
  const detail = stringValue(result?.detail);
  if (!httpStatus && !title && !detail) return null;
  const statusText = httpStatus ? `Provider returned HTTP ${httpStatus}` : "Provider returned an error";
  const titleText = title ? ` ${title}` : "";
  const detailText = detail ? `: ${detail}` : "";
  return `${statusText}${titleText}${detailText}.`;
}

function connectedAppToolFailure(
  callId: string,
  name: ConnectedAppProviderToolName,
  message: string,
  data?: unknown,
): NativeModelToolResult {
  const redactedData = redactSensitiveValue(data);
  return {
    toolCallId: callId,
    name,
    ok: false,
    contentText: JSON.stringify(
      {
        ok: false,
        action: name,
        output: message,
        ...(redactedData !== undefined ? { data: redactedData } : {}),
      },
      null,
      2,
    ),
    ...(redactedData !== undefined ? { data: redactedData } : {}),
  };
}

function connectedAppResultMetadata(
  context: ResolvedConnectedAppContext,
  operation: ConnectedAppProviderToolOperation,
  capabilityIds: string[],
): Record<string, unknown> {
  const bundle = connectedAppBundleByProvider(context.provider);
  return {
    provider: context.provider,
    providerLabel: context.label,
    operation,
    setupSurfaces: context.setupSurfaces,
    accountLabels: context.accountLabels,
    workspaceLabels: context.workspaceLabels,
    capabilityIds,
    availableToolDescriptors: bundle?.tools.map((tool) => ({
      name: tool.name,
      capabilityIds: tool.capabilityIds,
      write: tool.write,
    })) ?? [],
    availableOperationDescriptors: bundle?.operations
      .filter((providerOperation) => providerOperation.operation === operation)
      .map((providerOperation) => ({
        id: providerOperation.id,
        capabilityIds: providerOperation.capabilityIds,
        requiresReadback: providerOperation.requiresReadback,
        requiresRuntimeLease: providerOperation.requiresRuntimeLease,
        requiredInputKeys: providerOperation.input?.requiredKeys ?? [],
      })) ?? [],
  };
}

function hasWriteReadbackVerification(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (record.verifiedReadback === true || record.readbackVerified === true) return true;
  if (isRecord(record.readback)) return true;
  if (!isRecord(record.verification)) return false;
  const verification = record.verification;
  if (verification.verified === true || verification.readbackVerified === true) return true;
  return isRecord(verification.readback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providersForTool(
  contexts: ResolvedConnectedAppContext[],
  toolName: ConnectedAppProviderToolName,
): ConnectedAppProviderFamilyId[] {
  return contexts
    .filter((context) => connectedAppProviderToolNames(context).includes(toolName))
    .map((context) => context.provider);
}

function capabilitiesForOperation(
  context: Pick<ResolvedConnectedAppContext, "capabilities">,
  operation: ConnectedAppProviderToolOperation,
): Array<Pick<ResolvedConnectedAppContext["capabilities"][number], "access" | "id" | "label">> {
  const access = operation === "write" ? "write" : "read";
  return context.capabilities.filter((capability) => capability.access === access);
}

function dedupeContexts(contexts: ResolvedConnectedAppContext[]): ResolvedConnectedAppContext[] {
  const byProvider = new Map<ConnectedAppProviderFamilyId, ResolvedConnectedAppContext>();
  for (const context of contexts) {
    if (byProvider.has(context.provider)) continue;
    byProvider.set(context.provider, context);
  }
  return [...byProvider.values()];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^(?:bearer|oauth)\s+[a-z0-9._~+/=-]+$/i.test(value)) return "[redacted]";
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = redactSensitiveValue(child, depth + 1);
    }
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("idtoken") ||
    normalized.includes("oauth") ||
    normalized.includes("bearer") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("connectionid")
  );
}
