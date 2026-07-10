import { ChatProviderSchema, type ChatProvider } from "@openpond/contracts";
import type { HostedToolInstructionMode } from "../../openpond/hosted-tool-protocol.js";

export type HostedToolMode = "auto" | "native" | "text_fallback" | "disabled";

export type HostedToolRolloutFlags = {
  toolMode: HostedToolMode;
  nativeToolTransport: boolean;
  resourceTools: boolean;
  webSearchTool: boolean;
  dynamicActionTools: boolean;
  textToolFallback: boolean;
  nativeToolProviderAllowlist: readonly ChatProvider[] | "*";
  nativeToolProviderDenylist: readonly ChatProvider[];
};

const VERIFIED_NATIVE_TOOL_PROVIDERS = new Set<ChatProvider>([
  "openpond",
  "openai",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
]);

const DEFAULT_HOSTED_TOOL_ROLLOUT_FLAGS: HostedToolRolloutFlags = {
  toolMode: "auto",
  nativeToolTransport: true,
  resourceTools: true,
  webSearchTool: true,
  dynamicActionTools: true,
  textToolFallback: true,
  nativeToolProviderAllowlist: [],
  nativeToolProviderDenylist: [],
};

export function resolveHostedToolRolloutFlags(
  overrides: Partial<HostedToolRolloutFlags> = {},
): HostedToolRolloutFlags {
  const envFlags = hostedToolRolloutFlagsFromEnv(process.env);
  return {
    ...DEFAULT_HOSTED_TOOL_ROLLOUT_FLAGS,
    ...envFlags,
    ...overrides,
  };
}

export function nativeToolTransportEnabledForProvider(
  flags: HostedToolRolloutFlags,
  provider: ChatProvider,
): boolean {
  if (!flags.nativeToolTransport) return false;
  if (flags.toolMode === "disabled" || flags.toolMode === "text_fallback") return false;
  if (flags.nativeToolProviderDenylist.includes(provider)) return false;
  if (flags.toolMode === "native") return true;
  if (flags.nativeToolProviderAllowlist === "*") return true;
  if (flags.nativeToolProviderAllowlist.includes(provider)) return true;
  return VERIFIED_NATIVE_TOOL_PROVIDERS.has(provider);
}

export function hostedToolInstructionModeForProvider(
  flags: HostedToolRolloutFlags,
  provider: ChatProvider,
): HostedToolInstructionMode {
  if (!flags.textToolFallback || flags.toolMode === "disabled") return "none";
  if (nativeToolTransportEnabledForProvider(flags, provider) && flags.resourceTools) {
    return "resource_text_fallback";
  }
  return "full_text_fallback";
}

function hostedToolRolloutFlagsFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<HostedToolRolloutFlags> {
  const output: Partial<HostedToolRolloutFlags> = {};
  const toolMode = parseToolMode(env.OPENPOND_MODEL_TOOL_MODE);
  if (toolMode) output.toolMode = toolMode;
  const nativeToolTransport = parseBooleanEnv(env.OPENPOND_NATIVE_TOOL_TRANSPORT);
  if (nativeToolTransport !== null) output.nativeToolTransport = nativeToolTransport;
  const resourceTools = parseBooleanEnv(env.OPENPOND_RESOURCE_TOOLS);
  if (resourceTools !== null) output.resourceTools = resourceTools;
  const webSearchTool = parseBooleanEnv(env.OPENPOND_WEB_SEARCH_TOOL);
  if (webSearchTool !== null) output.webSearchTool = webSearchTool;
  const dynamicActionTools = parseBooleanEnv(env.OPENPOND_DYNAMIC_ACTION_TOOLS);
  if (dynamicActionTools !== null) output.dynamicActionTools = dynamicActionTools;
  const textToolFallback = parseBooleanEnv(env.OPENPOND_TEXT_TOOL_FALLBACK);
  if (textToolFallback !== null) output.textToolFallback = textToolFallback;
  const allowlist = parseProviderListEnv(env.OPENPOND_NATIVE_TOOL_PROVIDERS);
  if (allowlist) output.nativeToolProviderAllowlist = allowlist;
  const denylist = parseProviderListEnv(env.OPENPOND_NATIVE_TOOL_PROVIDER_DENYLIST);
  if (denylist && denylist !== "*") output.nativeToolProviderDenylist = denylist;
  return output;
}

function parseToolMode(value: string | undefined): HostedToolMode | null {
  const normalized = value?.trim();
  if (
    normalized === "auto" ||
    normalized === "native" ||
    normalized === "text_fallback" ||
    normalized === "disabled"
  ) {
    return normalized;
  }
  return null;
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return null;
}

function parseProviderListEnv(value: string | undefined): readonly ChatProvider[] | "*" | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized === "*") return "*";
  const providers = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ChatProviderSchema.safeParse(item))
    .filter((result) => result.success)
    .map((result) => result.data);
  return providers.length > 0 ? providers : null;
}
