import {
  buildConnectedAppInstallUrl,
  CONNECTED_APP_CATALOG,
  DEFAULT_CODEX_CHAT_MODEL,
  DEFAULT_OPENPOND_CHAT_MODEL,
  type BootstrapPayload,
  type ChatModelRef,
  type ChatProvider,
  type ProviderModel,
  type ProviderSettings,
} from "@openpond/contracts";
import type { SlashCommandDefinition } from "./ui/commands.js";

type ProfileState = BootstrapPayload["profile"];

export type TerminalModelSelection = {
  provider: ChatProvider;
  model: string | null;
};

type TerminalModelOption = {
  id: string;
  label: string;
  description: string;
};

const TERMINAL_MODEL_OPTIONS: TerminalModelOption[] = [
  {
    id: DEFAULT_OPENPOND_CHAT_MODEL,
    label: "OpenPond Chat",
    description: "default OpenPond hosted chat model",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "fast OpenPond-compatible model",
  },
];

const OPENAI_COMPATIBLE_CHAT_PROVIDER_IDS = [
  "openai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
  "custom-openai-compatible",
] as const satisfies readonly ChatProvider[];

const RUNNABLE_CHAT_PROVIDER_IDS = [
  "openpond",
  "codex",
  ...OPENAI_COMPATIBLE_CHAT_PROVIDER_IDS,
] as const satisfies readonly ChatProvider[];

const RUNNABLE_CHAT_PROVIDER_ID_SET = new Set<ChatProvider>(
  RUNNABLE_CHAT_PROVIDER_IDS
);

export function normalizeTerminalProvider(value: string | null): ChatProvider | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (RUNNABLE_CHAT_PROVIDER_ID_SET.has(normalized as ChatProvider)) {
    return normalized as ChatProvider;
  }
  return null;
}

export function parseProviderModelSelection(
  value: string | null,
  currentProvider: ChatProvider
): { provider: ChatProvider | null; model: string | null } {
  const normalized = value?.trim();
  if (!normalized) return { provider: null, model: null };
  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0) {
    const provider = normalizeTerminalProvider(normalized.slice(0, slashIndex));
    if (provider) {
      return {
        provider,
        model: normalizeTerminalModel(normalized.slice(slashIndex + 1)),
      };
    }
  }
  return {
    provider: currentProvider,
    model: normalizeTerminalModel(normalized),
  };
}

export function normalizeTerminalModel(value: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (
    lower === "default" ||
    lower === "openpond chat" ||
    lower === DEFAULT_OPENPOND_CHAT_MODEL
  ) {
    return null;
  }
  return normalized;
}

export function providerLabel(
  settings: ProviderSettings | null | undefined,
  provider: ChatProvider
): string {
  if (provider === "openpond") return "OpenPond";
  return settings?.statuses[provider]?.displayName ?? (provider === "codex" ? "Codex" : provider);
}

function modelOptionFromProviderModel(model: ProviderModel): TerminalModelOption {
  const details = [
    model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K context` : "",
    model.capabilities.reasoning ? "reasoning" : "",
    model.source,
  ].filter(Boolean);
  return {
    id: model.id,
    label: model.displayName || model.id,
    description: details.join(", ") || model.providerId,
  };
}

export function modelOptionsForProvider(
  settings: ProviderSettings | null | undefined,
  provider: ChatProvider
): TerminalModelOption[] {
  if (provider === "openpond") {
    return TERMINAL_MODEL_OPTIONS.filter((option) => option.id === DEFAULT_OPENPOND_CHAT_MODEL);
  }
  if (provider === "codex") {
    return [
      { id: DEFAULT_CODEX_CHAT_MODEL, label: "GPT-5.5", description: "default Codex model" },
      { id: "gpt-5.4", label: "GPT-5.4", description: "Codex model" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Codex model" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "Codex model" },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", description: "Codex model" },
      { id: "gpt-5.2", label: "GPT-5.2", description: "Codex model" },
    ];
  }
  const cacheModels = settings?.modelCaches[provider]?.models ?? [];
  const config = settings?.providers[provider];
  const manualModels = [...(config?.modelOverrides ?? []), config?.defaultModel]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((id) => ({ id, label: id, description: "manual" }));
  const seen = new Set<string>();
  const options: TerminalModelOption[] = [];
  for (const option of [...cacheModels.map(modelOptionFromProviderModel), ...manualModels]) {
    if (!option.id || seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  return options;
}

function defaultModelId(
  settings: ProviderSettings | null | undefined,
  provider: ChatProvider
): string {
  const configDefault = settings?.providers[provider]?.defaultModel?.trim();
  if (configDefault) return configDefault;
  const statusDefault = settings?.statuses[provider]?.defaultModel?.trim();
  if (statusDefault) return statusDefault;
  const firstOption = modelOptionsForProvider(settings, provider)[0]?.id?.trim();
  if (firstOption) return firstOption;
  if (provider === "codex") return DEFAULT_CODEX_CHAT_MODEL;
  if (provider === "openpond") return DEFAULT_OPENPOND_CHAT_MODEL;
  return "";
}

export function activeModelId(
  options: TerminalModelSelection,
  settings?: ProviderSettings | null
): string {
  const normalized = normalizeTerminalModel(options.model);
  if (normalized) return normalized;
  return defaultModelId(settings, options.provider);
}

export function activeModelRef(
  options: TerminalModelSelection,
  settings?: ProviderSettings | null
): ChatModelRef | undefined {
  const modelId = activeModelId(options, settings);
  return modelId ? { providerId: options.provider, modelId } : undefined;
}

export function modelLabel(
  settings: ProviderSettings | null | undefined,
  options: TerminalModelSelection
): string {
  const id = activeModelId(options, settings);
  return modelOptionsForProvider(settings, options.provider).find((option) => option.id === id)?.label ?? (id || "No model");
}

export function formatProviderOptions(
  settings: ProviderSettings | null | undefined,
  activeProvider: ChatProvider
): string {
  const rows = RUNNABLE_CHAT_PROVIDER_IDS.map((provider) => {
    const status = settings?.statuses[provider];
    const marker = provider === activeProvider ? "*" : " ";
    const state = status?.available
      ? "ready"
      : status?.credential.connected
        ? "configured"
        : status?.routing.localByok
          ? "needs-key"
          : "unavailable";
    return `${marker} ${provider.padEnd(25)}  ${providerLabel(settings, provider)} - ${state}`;
  });
  return ["Providers:", ...rows].join("\n");
}

export function formatModelOptions(
  settings: ProviderSettings | null | undefined,
  provider: ChatProvider,
  model: string | null
): string {
  const options = modelOptionsForProvider(settings, provider);
  const active = activeModelId({ provider, model }, settings);
  const displayOptions =
    active && !options.some((option) => option.id === active)
      ? [{ id: active, label: active, description: "manual" }, ...options]
      : options;
  if (displayOptions.length === 0) {
    return `No cached models for ${providerLabel(settings, provider)}. Configure a default model in Desktop settings.`;
  }
  const idWidth = Math.min(48, Math.max(...displayOptions.map((option) => option.id.length)));
  return displayOptions
    .map((option) => {
      const marker = option.id === active ? "*" : " ";
      return `${marker} ${option.id.padEnd(idWidth)}  ${option.label} - ${option.description}`;
    })
    .join("\n");
}

export function resolveModelSelection(
  settings: ProviderSettings | null | undefined,
  provider: ChatProvider,
  inputModel: string
): { changed: boolean; model: string | null; message: string } {
  const normalized = normalizeTerminalModel(inputModel);
  if (!normalized) {
    return {
      changed: true,
      model: null,
      message: `Model reset to ${defaultModelId(settings, provider) || "provider default"}`,
    };
  }
  const options = modelOptionsForProvider(settings, provider);
  const exact = options.find((option) => option.id === normalized);
  if (exact) return { changed: true, model: exact.id, message: `Model set to ${exact.label}` };
  const matches = options.filter((option) =>
    `${option.id} ${option.label}`.toLowerCase().includes(normalized.toLowerCase())
  );
  if (matches.length === 1) {
    return { changed: true, model: matches[0]!.id, message: `Model set to ${matches[0]!.label}` };
  }
  if (matches.length > 1) {
    const idWidth = Math.min(48, Math.max(...matches.map((option) => option.id.length)));
    return {
      changed: false,
      model: null,
      message: [
        `Model matches for ${normalized}:`,
        ...matches.slice(0, 20).map((option) => `${option.id.padEnd(idWidth)}  ${option.label}`),
        matches.length > 20 ? `... ${matches.length - 20} more` : "",
      ].filter(Boolean).join("\n"),
    };
  }
  return { changed: true, model: normalized, message: `Model set to ${normalized}` };
}

export function formatConnectedApps(payload: BootstrapPayload | null): string {
  const baseUrl = payload?.account.baseUrl ?? payload?.account.activeProfile?.baseUrl ?? null;
  const teamId = payload?.preferences.defaultTeamId ?? null;
  const idWidth = Math.max(...CONNECTED_APP_CATALOG.map((app) => app.id.length));
  const rows = CONNECTED_APP_CATALOG.map((app) => {
    const url = buildConnectedAppInstallUrl({ appId: app.id, baseUrl, teamId });
    return `${app.id.padEnd(idWidth)}  ${app.label} - ${app.description}\n${" ".repeat(idWidth + 2)}  ${url}`;
  });
  return ["Apps:", ...rows, "", "Use /install <app> to open setup."].join("\n");
}

export function installAppOptions(query: string): SlashCommandDefinition[] {
  const normalized = query.trim().toLowerCase();
  return CONNECTED_APP_CATALOG.filter((app) => {
    if (!normalized) return true;
    return [app.id, app.label, app.shortLabel, app.category].some((value) =>
      value.toLowerCase().includes(normalized)
    );
  }).map((app) => ({
    name: `install:${app.id}`,
    usage: `/install ${app.id}`,
    description: `${app.label} - ${app.category}`,
    submitText: `/install ${app.id}`,
  }));
}

export function installAppQuery(text: string): string | null {
  const match = text.match(/^\/install(?:\s+([A-Za-z0-9_-]*))?$/);
  return match ? match[1] ?? "" : null;
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "none";
}

export function formatProfileStatus(profile: ProfileState): string {
  if (profile.mode === "none") return "No active OpenPond profile. Run `openpond init`.";
  const git = profile.git;
  const lines = [
    `Profile: ${profile.activeProfile ?? "default"}`,
    `State: ${profile.summary.state} - ${profile.summary.message}`,
    `Repo: ${profile.repoPath}`,
    `Source: ${profile.sourcePath ?? "missing"}`,
    git
      ? `Git: ${git.branch ?? "detached"} ${shortSha(git.head)}${git.dirty ? " dirty" : ""}${git.upstream ? ` -> ${git.upstream}` : ""}`
      : "Git: not initialized",
    profile.hosted?.sourceCommitSha
      ? `Hosted: ${profile.hosted.teamId ?? "team"} ${shortSha(profile.hosted.sourceCommitSha)}`
      : "Hosted: not pushed",
    `Catalog: ${profile.catalog.actionCount} actions${profile.catalog.stale ? " stale" : ""}${profile.catalog.error ? ` (${profile.catalog.error})` : ""}`,
    `Setup gate: ${profile.setupGate.status} (${profile.setupGate.blockingCount} blocking, ${profile.setupGate.optionalMissingCount} optional missing)`,
    profile.summary.defaultAction ? `Default action: ${profile.summary.defaultAction}` : "Default action: none",
    profile.lastCheck
      ? `Last check: ${profile.lastCheck.command} ${profile.lastCheck.status} at ${profile.lastCheck.checkedAt}`
      : "Last check: none",
    profile.summary.checkStaleReason ? `Check stale: ${profile.summary.checkStaleReason}` : "",
    profile.setupGate.blockingRequirements.length
      ? `Blocking setup: ${profile.setupGate.blockingRequirements.map(formatProfileSetupRequirement).join(", ")}`
      : "",
    profile.error ? `Error: ${profile.error}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatProfileDiff(profile: ProfileState): string {
  if (profile.mode === "none") return "No active OpenPond profile. Run `openpond init`.";
  const diff = profile.diff;
  const lines = [
    diff.newAgents.length ? `New agents: ${diff.newAgents.join(", ")}` : "",
    diff.changedAgents.length ? `Changed agents: ${diff.changedAgents.join(", ")}` : "",
    diff.deletedAgents.length ? `Deleted agents: ${diff.deletedAgents.join(", ")}` : "",
    diff.changedActions.length ? `Changed actions: ${diff.changedActions.join(", ")}` : "",
    diff.changedExtensions.length ? `Extensions: ${diff.changedExtensions.join(", ")}` : "",
    diff.setupChanges.length ? `Setup: ${diff.setupChanges.join(", ")}` : "",
    diff.envRequirementChanges.length ? `Env requirements: ${diff.envRequirementChanges.join(", ")}` : "",
  ].filter(Boolean);
  if (diff.files.length) {
    lines.push(
      "Files:",
      ...diff.files.slice(0, 25).map((file) => `${file.status.padEnd(2)} ${file.path}`)
    );
    if (diff.files.length > 25) lines.push(`... ${diff.files.length - 25} more files`);
  }
  return lines.length ? lines.join("\n") : "No local profile diff.";
}

export function formatProfileCatalog(profile: ProfileState): string {
  if (profile.mode === "none") return "No active OpenPond profile. Run `openpond init`.";
  if (profile.actionCatalog.length === 0) return "No profile actions found. Run `openpond profile check build`.";
  return profile.actionCatalog
    .map((action) => {
      const label = action.label ?? action.name ?? action.id;
      const description = action.description ? ` - ${action.description}` : "";
      const setup = blockingSetupRequirementsForAction(profile, action.id);
      const setupStatus = setup.length
        ? ` setup_required:${setup.map((requirement) => requirement.label).join(",")}`
        : "";
      return `${action.id}  ${label}${description}${setupStatus}`;
    })
    .join("\n");
}

export function formatProfileAgents(
  profile: ProfileState,
  activeAgentId: string | null
): string {
  if (profile.agents.length === 0) return "No profile agents found.";
  const agentLines = profile.agents.map(
    (agent) => `${agent.id === activeAgentId ? "*" : " "} ${agent.id}  ${agent.enabled ? "enabled" : "disabled"}  ${agent.path}`
  );
  const actionLines = profile.actionCatalog.map((action) => {
    const setup = blockingSetupRequirementsForAction(profile, action.id);
    const setupStatus = setup.length
      ? `  setup_required:${setup.map((requirement) => requirement.label).join(",")}`
      : "";
    return `  /run ${action.id}  ${action.label ?? action.name ?? ""}${setupStatus}`.trimEnd();
  });
  return [...agentLines, actionLines.length ? "\nActions:" : "", ...actionLines].filter(Boolean).join("\n");
}

export function blockingSetupRequirementsForAction(
  profile: ProfileState,
  actionId: string
) {
  return profile.setupGate.blockingRequirements.filter(
    (requirement) => requirement.actionId === null || requirement.actionId === actionId
  );
}

function formatProfileSetupRequirement(
  requirement: ProfileState["setupGate"]["blockingRequirements"][number]
): string {
  const prefix = requirement.actionId ? `${requirement.actionId}: ` : "";
  return `${prefix}${requirement.label} (${requirement.status})`;
}
