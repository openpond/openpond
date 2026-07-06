import {
  buildConnectedAppInstallUrl,
  connectedAppById,
  type Approval,
  type BootstrapPayload,
  type OpenPondCommandAccessMode,
} from "@openpond/contracts";
import type { TerminalOptions } from "./args.js";
import { apiFetch } from "./connection.js";
import {
  activeModelId,
  activeModelRef,
  blockingSetupRequirementsForAction,
  formatConnectedApps,
  formatModelOptions,
  formatProfileAgents,
  formatProfileCatalog,
  formatProfileDiff,
  formatProfileStatus,
  formatProviderOptions,
  modelLabel,
  normalizeTerminalProvider,
  parseProviderModelSelection,
  providerLabel,
  resolveModelSelection,
} from "./formatting.js";
import { formatTerminalProjects, resolveTerminalProjectTarget } from "./projects.js";
import {
  createTerminalChatSession,
  type TerminalSessionConnection,
} from "./session-state.js";
import {
  commandAccessModeForSession,
  formatTerminalCommandApprovalQuestion,
  formatTerminalPermissionMode,
  formatTerminalPermissionsSummary,
  latestPendingCommandApproval,
  parseTerminalPermissionChoice,
  parseTerminalPermissionMode,
  terminalPermissionDecision,
  type TerminalPermissionChoice,
} from "./permissions.js";
import { helpText, type SlashCommand } from "./ui/commands.js";
import { systemItem, type TranscriptItem } from "./ui/transcript.js";

type ProfileRunResponse = {
  action: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

export type TerminalCommandContext = {
  options: TerminalOptions;
  getConnection(): TerminalSessionConnection | null;
  getPayload(): BootstrapPayload | null;
  setPayload(payload: BootstrapPayload): void;
  getActiveSessionId(): string | null;
  setActiveSessionId(sessionId: string): void;
  getActiveAgentId(): string | null;
  setActiveAgentId(agentId: string): void;
  getPendingCommandApproval?: () => Approval | null;
  openCommandApprovalQuestion?: (approval: Approval) => void;
  refreshBootstrap(refreshCodex?: boolean): Promise<BootstrapPayload>;
  addItem(item: TranscriptItem): void;
  clearTranscript(): void;
  requestExit(): void;
  render(): void;
  openUrl(url: string): void;
};

export async function handleTerminalSlashCommand(
  command: SlashCommand,
  context: TerminalCommandContext
): Promise<void> {
  const connection = context.getConnection();
  if (!connection) return;
  if (command.type === "exit") {
    context.requestExit();
    return;
  }
  if (command.type === "clear") {
    context.clearTranscript();
    context.render();
    return;
  }
  if (command.type === "help") {
    context.addItem(systemItem(helpText()));
    return;
  }
  if (command.type === "projects") {
    const latest = await context.refreshBootstrap();
    context.addItem(systemItem(formatTerminalProjects(latest)));
    return;
  }
  if (command.type === "providers") {
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    context.addItem(systemItem(formatProviderOptions(latest.providers, context.options.provider)));
    return;
  }
  if (command.type === "provider") {
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    if (!command.id) {
      context.addItem(systemItem(formatProviderOptions(latest.providers, context.options.provider)));
      return;
    }
    const provider = normalizeTerminalProvider(command.id);
    if (!provider) {
      context.addItem(systemItem(`Unknown provider: ${command.id}\n\n${formatProviderOptions(latest.providers, context.options.provider)}`, "warning"));
      return;
    }
    context.options.provider = provider;
    context.options.model = null;
    context.addItem(systemItem(`Provider set to ${providerLabel(latest.providers, provider)} / ${modelLabel(latest.providers, context.options)}`));
    context.render();
    return;
  }
  if (command.type === "apps") {
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    context.addItem(systemItem(formatConnectedApps(latest)));
    return;
  }
  if (command.type === "install") {
    const app = connectedAppById(command.id);
    if (!app) {
      context.addItem(systemItem(`Unknown app: ${command.id}\n\n${formatConnectedApps(context.getPayload())}`, "warning"));
      return;
    }
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    const url = buildConnectedAppInstallUrl({
      appId: app.id,
      baseUrl: latest.account.baseUrl ?? latest.account.activeProfile?.baseUrl ?? null,
      teamId: latest.preferences.defaultTeamId ?? null,
    });
    context.openUrl(url);
    context.addItem(systemItem(`Opened ${app.label} setup:\n${url}`));
    return;
  }
  if (command.type === "project") {
    if (!command.id) {
      context.addItem(systemItem("Usage: /project <id>", "warning"));
      return;
    }
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    const target = resolveTerminalProjectTarget(latest, command.id);
    if (!target) {
      context.addItem(systemItem(`Project not found: ${command.id}\n\n${formatTerminalProjects(latest)}`, "warning"));
      return;
    }
    context.options.project = target.id;
    if (target.provider) {
      context.options.provider = target.provider;
      context.options.model = null;
    }
    const session = await createTerminalChatSession(connection, latest, context.options);
    context.setActiveSessionId(session.id);
    context.addItem(systemItem(`Project set to ${target.kind}: ${target.label}`));
    context.render();
    return;
  }
  if (command.type === "model") {
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    if (!command.id) {
      context.addItem(systemItem(formatModelOptions(latest.providers, context.options.provider, context.options.model)));
      return;
    }
    const selection = parseProviderModelSelection(command.id, context.options.provider);
    if (selection.provider) {
      context.options.provider = selection.provider;
    }
    const resolved = resolveModelSelection(
      latest.providers,
      context.options.provider,
      selection.model ?? "default",
    );
    if (resolved.changed) context.options.model = resolved.model;
    context.addItem(systemItem(`${providerLabel(latest.providers, context.options.provider)} / ${resolved.message}`));
    context.render();
    return;
  }
  if (command.type === "permissions") {
    await handlePermissionsCommand(command.args, context, connection);
    return;
  }
  if (command.type === "agents") {
    const latest = await context.refreshBootstrap();
    context.addItem(systemItem(formatProfileAgents(latest.profile, context.getActiveAgentId())));
    return;
  }
  if (command.type === "agent") {
    const latest = await context.refreshBootstrap();
    const agent = latest.profile.agents.find((candidate) => candidate.id === command.id);
    if (!agent) {
      context.addItem(systemItem(`Profile agent not found: ${command.id}`, "warning"));
      return;
    }
    context.setActiveAgentId(agent.id);
    context.addItem(systemItem(`Agent set to ${agent.id}`));
    context.render();
    return;
  }
  if (command.type === "profile") {
    await handleProfileCommand(command.args, context, connection);
    return;
  }
  if (command.type === "run") {
    if (!command.action) {
      context.addItem(systemItem("Usage: /run <action> [json]", "warning"));
      return;
    }
    const latest = await context.refreshBootstrap();
    const catalogAction = latest.profile.actionCatalog.find((action) => action.id === command.action);
    if (!catalogAction) {
      context.addItem(systemItem(`Profile action not found: ${command.action}. Run /profile catalog.`, "warning"));
      return;
    }
    const blockingSetup = blockingSetupRequirementsForAction(latest.profile, command.action);
    if (blockingSetup.length > 0) {
      context.addItem(
        systemItem(
          [
            "agent_source_setup_required",
            `Profile action ${command.action} has unresolved required setup.`,
            `Missing setup: ${blockingSetup.map((requirement) => requirement.label).join(", ")}`,
          ].join("\n"),
          "warning",
        ),
      );
      return;
    }
    const result = await apiFetch<ProfileRunResponse>(connection.server, connection.token, "/v1/profile/run", {
      method: "POST",
      body: JSON.stringify({ action: command.action, input: command.input }),
    });
    context.addItem(systemItem([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || `${result.action} completed`));
    return;
  }
  if (command.type === "settings") {
    await handleSettingsCommand(command.args, context, connection);
    return;
  }
  if (command.type === "logs") {
    const latest = await context.refreshBootstrap();
    const lines = latest.events
      .slice(-20)
      .map((event) => `${event.timestamp} ${event.name} ${event.output ?? event.error ?? ""}`.trim());
    context.addItem(systemItem(lines.join("\n") || "No recent events."));
    return;
  }
  if (command.type === "compact") {
    const activeSessionId = context.getActiveSessionId();
    if (!activeSessionId) return;
    await apiFetch(connection.server, connection.token, `/v1/sessions/${activeSessionId}/compact`, {
      method: "POST",
      body: JSON.stringify({
        reason: "manual",
        model: activeModelId(context.options, context.getPayload()?.providers),
        modelRef: activeModelRef(context.options, context.getPayload()?.providers),
      }),
    });
    context.addItem(systemItem("Compaction started."));
    return;
  }
  if (command.type === "hooks") {
    context.addItem(systemItem("Hooks are registered in the shared local runtime; destructive hooks are disabled by default."));
    return;
  }
  if (command.type === "start") {
    const latest = context.getPayload() ?? (await context.refreshBootstrap());
    const session = await createTerminalChatSession(connection, latest, context.options);
    context.setActiveSessionId(session.id);
    context.addItem(systemItem(`Started ${session.id}`));
    context.render();
    return;
  }
  context.addItem(systemItem(`Unknown command: ${command.command}`, "warning"));
}

async function handlePermissionsCommand(
  args: string[],
  context: TerminalCommandContext,
  connection: TerminalSessionConnection,
): Promise<void> {
  const latest = await context.refreshBootstrap();
  const activeSessionId = context.getActiveSessionId();
  const pendingApproval =
    context.getPendingCommandApproval?.() ??
    latestPendingCommandApproval(latest, activeSessionId);
  const first = args[0] ?? null;
  const choice = parseTerminalPermissionChoice(first);

  if (choice) {
    if (!pendingApproval) {
      context.addItem(systemItem("No command approval is pending.", "warning"));
      return;
    }
    await resolveTerminalCommandApproval(connection, pendingApproval.id, choice);
    context.addItem(systemItem(`Command approval resolved: ${choice}.`));
    return;
  }

  if (pendingApproval && !first) {
    if (context.openCommandApprovalQuestion) {
      context.openCommandApprovalQuestion(pendingApproval);
    } else {
      context.addItem(systemItem(formatTerminalCommandApprovalQuestion(pendingApproval), "warning"));
    }
    return;
  }

  const mode = parseTerminalPermissionMode(first);
  if (mode) {
    if (!activeSessionId) {
      context.addItem(systemItem("No active session.", "warning"));
      return;
    }
    await patchTerminalSessionCommandAccess(connection, activeSessionId, mode);
    await context.refreshBootstrap();
    context.addItem(systemItem(`Command access set to ${formatTerminalPermissionMode(mode)}.`));
    return;
  }

  if (first) {
    context.addItem(
      systemItem("Usage: /permissions [ask|full-access|yes|session|no|skip]", "warning"),
    );
    return;
  }

  context.addItem(systemItem(formatTerminalPermissionsSummary(commandAccessModeForSession(latest, activeSessionId))));
}

export async function resolveTerminalCommandApproval(
  connection: TerminalSessionConnection,
  approvalId: string,
  choice: TerminalPermissionChoice,
): Promise<Approval> {
  return apiFetch<Approval>(
    connection.server,
    connection.token,
    `/v1/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision: terminalPermissionDecision(choice) }),
    },
  );
}

async function patchTerminalSessionCommandAccess(
  connection: TerminalSessionConnection,
  sessionId: string,
  mode: OpenPondCommandAccessMode,
): Promise<void> {
  await apiFetch(connection.server, connection.token, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ openPondCommandAccessMode: mode }),
  });
}

async function handleSettingsCommand(
  args: string[],
  context: TerminalCommandContext,
  connection: TerminalSessionConnection
): Promise<void> {
  const latest = context.getPayload() ?? (await context.refreshBootstrap());
  const subcommand = args[0] ?? "show";
  if (subcommand === "show") {
    context.addItem(systemItem(formatTerminalSettings(latest)));
    return;
  }
  if (subcommand !== "goal-storage") {
    context.addItem(systemItem("Usage: /settings [goal-storage global|workspace]", "warning"));
    return;
  }
  const location = args[1];
  if (location !== "global" && location !== "workspace") {
    context.addItem(systemItem("Usage: /settings goal-storage global|workspace", "warning"));
    return;
  }
  const updated = await apiFetch<BootstrapPayload>(connection.server, connection.token, "/v1/preferences", {
    method: "PATCH",
    body: JSON.stringify({ goalStorageLocation: location }),
  });
  context.setPayload(updated);
  context.addItem(systemItem(`Goal storage set to ${goalStorageLabel(updated.preferences.goalStorageLocation)}.`));
}

function formatTerminalSettings(payload: BootstrapPayload): string {
  return [
    "Settings:",
    `Goal storage: ${goalStorageLabel(payload.preferences.goalStorageLocation)}`,
    "",
    "Change it with /settings goal-storage global or /settings goal-storage workspace.",
  ].join("\n");
}

function goalStorageLabel(location: BootstrapPayload["preferences"]["goalStorageLocation"]): string {
  return location === "workspace" ? ".openpond/goals in the working directory" : "~/.openpond/goals";
}

async function handleProfileCommand(
  args: string[],
  context: TerminalCommandContext,
  connection: TerminalSessionConnection
): Promise<void> {
  const subcommand = args[0] ?? "current";
  if (subcommand === "init") {
    const profileState = await apiFetch(connection.server, connection.token, "/v1/profile/init", {
      method: "POST",
      body: JSON.stringify({ path: args[1] }),
    });
    await context.refreshBootstrap();
    context.addItem(systemItem(JSON.stringify(profileState, null, 2)));
    return;
  }
  if (subcommand === "load") {
    if (!args[1]) {
      context.addItem(systemItem("Usage: /profile load <path> [profile]", "warning"));
      return;
    }
    const profileState = await apiFetch(connection.server, connection.token, "/v1/profile/load", {
      method: "POST",
      body: JSON.stringify({ path: args[1], profile: args[2] }),
    });
    await context.refreshBootstrap();
    context.addItem(systemItem(JSON.stringify(profileState, null, 2)));
    return;
  }
  if (subcommand === "check") {
    const profileState = await apiFetch<BootstrapPayload["profile"]>(connection.server, connection.token, "/v1/profile/check", {
      method: "POST",
      body: JSON.stringify({ kind: args[1] ?? "all" }),
    });
    await context.refreshBootstrap();
    context.addItem(systemItem(formatProfileStatus(profileState)));
    return;
  }
  if (subcommand === "commit") {
    const message = args.slice(1).join(" ").trim() || undefined;
    const result = await apiFetch(connection.server, connection.token, "/v1/profile/commit", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    await context.refreshBootstrap();
    context.addItem(systemItem(JSON.stringify(result, null, 2)));
    return;
  }
  if (subcommand === "push") {
    const teamId = args[1];
    if (!teamId) {
      context.addItem(systemItem("Usage: /profile push <teamId>", "warning"));
      return;
    }
    const result = await apiFetch(connection.server, connection.token, "/v1/profile/push", {
      method: "POST",
      body: JSON.stringify({ teamId, ensureHosted: true }),
    });
    const latest = await context.refreshBootstrap();
    context.addItem(systemItem([`Pushed profile to ${teamId}.`, formatProfileStatus(latest.profile), JSON.stringify(result, null, 2)].join("\n\n")));
    return;
  }
  const latest = await context.refreshBootstrap();
  if (latest.profile.mode === "none") {
    context.addItem(systemItem("No active OpenPond profile. Run `openpond init`.", "warning"));
    return;
  }
  if (subcommand === "diff") {
    context.addItem(systemItem(formatProfileDiff(latest.profile)));
    return;
  }
  if (subcommand === "catalog" || subcommand === "actions") {
    context.addItem(systemItem(formatProfileCatalog(latest.profile)));
    return;
  }
  context.addItem(systemItem(formatProfileStatus(latest.profile)));
}
