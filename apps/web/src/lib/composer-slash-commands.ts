export type ComposerSlashCommandId =
  | "create"
  | "edit"
  | "skill"
  | "goal"
  | "goal-local"
  | "goal-remote"
  | "insights"
  | "train"
  | "submit-issue"
  | "sync-cloud";

export type ComposerSlashCommand = {
  id: ComposerSlashCommandId;
  command: `/${ComposerSlashCommandId}`;
  label: string;
  description: string;
  subcommands?: readonly string[];
};

export type ParsedComposerSlashCommand = {
  command: ComposerSlashCommandId;
  args: string;
};

export type ParsedComposerDirectCommand = {
  command: string;
};

export const COMPOSER_SLASH_COMMANDS: ComposerSlashCommand[] = [
  {
    id: "create",
    command: "/create",
    label: "Make Agent",
    description: "Start the guided Agent creation flow.",
  },
  {
    id: "skill",
    command: "/skill",
    label: "Manage skills",
    description: "Create, edit, and use reusable skills for the selected provider.",
    subcommands: ["create", "edit", "list", "help"],
  },
  {
    id: "goal",
    command: "/goal",
    label: "Run a goal",
    description: "Run a durable task for OpenPond or Codex to pursue.",
  },
  {
    id: "insights",
    command: "/insights",
    label: "Open insights",
    description: "Scan agent flow health.",
  },
  {
    id: "submit-issue",
    command: "/submit-issue",
    label: "Submit issue",
    description: "File a GitHub issue in openpond/openpond through the connected GitHub app.",
  },
  {
    id: "edit",
    command: "/edit",
    label: "Edit selected agent",
    description: "Refine the current project agent or workflow.",
  },
  {
    id: "goal-remote",
    command: "/goal-remote",
    label: "Run a cloud goal",
    description: "Open a Cloud work item and track the hosted goal loop.",
  },
  {
    id: "goal-local",
    command: "/goal-local",
    label: "Run a local goal",
    description: "Keep the goal in the current local OpenPond workspace.",
  },
  {
    id: "train",
    command: "/train",
    label: "Create training task",
    description: "Create a training plan from this chat or select chats in Training.",
  },
  {
    id: "sync-cloud",
    command: "/sync-cloud",
    label: "Upload/sync to Cloud",
    description: "Start a chat-visible source upload for the selected Project.",
  },
];

const COMPOSER_SLASH_COMMAND_IDS = new Set<ComposerSlashCommandId>(
  COMPOSER_SLASH_COMMANDS.map((command) => command.id),
);

export function composerSlashCommandText(command: ComposerSlashCommand): string {
  return `${command.command} `;
}

export function composerSlashCommandDetail(command: ComposerSlashCommand): string {
  if (command.subcommands?.length) {
    return command.subcommands.join(", ");
  }
  return command.description;
}

function composerSlashCommandPrimarySearchText(command: ComposerSlashCommand): string {
  return [
    command.id,
    command.command,
    command.label,
    command.description,
  ].join(" ");
}

function composerSlashCommandSubcommandSearchText(command: ComposerSlashCommand): string {
  return (command.subcommands ?? [])
    .flatMap((subcommand) => [
      subcommand,
      `${command.id} ${subcommand}`,
      `${command.command} ${subcommand}`,
    ])
    .join(" ");
}

export function parseComposerSlashCommandPrompt(prompt: string): ParsedComposerSlashCommand | null {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return null;
  const command = match[1];
  if (!COMPOSER_SLASH_COMMAND_IDS.has(command as ComposerSlashCommandId)) {
    return null;
  }
  return {
    command: command as ComposerSlashCommandId,
    args: match[2]?.trim() ?? "",
  };
}

export function parseComposerDirectCommandPrompt(prompt: string): ParsedComposerDirectCommand | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("!")) return null;
  const command = trimmed.slice(1).trim();
  return command ? { command } : null;
}

export function composerSlashCommandMatches({
  commands = COMPOSER_SLASH_COMMANDS,
  prompt,
  limit = 10,
}: {
  commands?: ComposerSlashCommand[];
  prompt: string;
  limit?: number;
}): ComposerSlashCommand[] {
  if (!prompt.startsWith("/")) return [];
  const query = prompt.slice(1).trim().toLowerCase();
  if (!query) return commands.slice(0, limit);

  const commandPrefixMatches = commands.filter((command) =>
    command.id.startsWith(query),
  );
  if (commandPrefixMatches.length > 0) {
    return commandPrefixMatches.slice(0, limit);
  }

  const primaryMatches = commands.filter((command) =>
    composerSlashCommandPrimarySearchText(command).toLowerCase().includes(query),
  );
  const matches = primaryMatches.length > 0
    ? primaryMatches
    : commands.filter((command) =>
      composerSlashCommandSubcommandSearchText(command).toLowerCase().includes(query),
    );
  return matches.slice(0, limit);
}
