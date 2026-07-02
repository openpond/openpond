export type ComposerSlashCommandId =
  | "create"
  | "edit"
  | "goal"
  | "goal-local"
  | "goal-remote"
  | "insights";

export type ComposerSlashCommand = {
  id: ComposerSlashCommandId;
  command: `/${ComposerSlashCommandId}`;
  label: string;
  description: string;
};

export type ParsedComposerSlashCommand = {
  command: ComposerSlashCommandId;
  args: string;
};

export const COMPOSER_SLASH_COMMANDS: ComposerSlashCommand[] = [
  {
    id: "create",
    command: "/create",
    label: "Create agent or project",
    description: "Start a guided creation flow in OpenPond Cloud.",
  },
  {
    id: "edit",
    command: "/edit",
    label: "Edit selected agent",
    description: "Refine the current project agent or workflow.",
  },
  {
    id: "goal",
    command: "/goal",
    label: "Run a goal",
    description: "Run a durable task for OpenPond or Codex to pursue.",
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
    id: "insights",
    command: "/insights",
    label: "Open insights",
    description: "Scan agent flow health.",
  },
];

const COMPOSER_SLASH_COMMAND_IDS = new Set<ComposerSlashCommandId>(
  COMPOSER_SLASH_COMMANDS.map((command) => command.id),
);

export function composerSlashCommandText(command: ComposerSlashCommand): string {
  return `${command.command} `;
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

export function composerSlashCommandMatches({
  commands = COMPOSER_SLASH_COMMANDS,
  prompt,
  limit = 8,
}: {
  commands?: ComposerSlashCommand[];
  prompt: string;
  limit?: number;
}): ComposerSlashCommand[] {
  if (!prompt.startsWith("/")) return [];
  const query = prompt.slice(1).trim().toLowerCase();
  return commands
    .filter((command) => {
      if (!query) return true;
      return [
        command.id,
        command.command,
        command.label,
        command.description,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, limit);
}
