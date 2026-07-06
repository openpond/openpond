export type SlashCommand =
  | { type: "agent"; id: string }
  | { type: "agents" }
  | { type: "apps" }
  | { type: "clear" }
  | { type: "compact" }
  | { type: "exit" }
  | { type: "help" }
  | { type: "hooks" }
  | { type: "install"; id: string }
  | { type: "logs" }
  | { type: "model"; id: string | null }
  | { type: "permissions"; args: string[] }
  | { type: "provider"; id: string | null }
  | { type: "providers" }
  | { type: "profile"; args: string[] }
  | { type: "project"; id: string }
  | { type: "projects" }
  | { type: "run"; action: string; input: unknown }
  | { type: "settings"; args: string[] }
  | { type: "start" }
  | { type: "unknown"; command: string };

export type SlashCommandDefinition = {
  name: string;
  description: string;
  usage: string;
  requiresArgument?: boolean;
  submitText?: string;
};

export type ParsedDirectCommand = {
  command: string;
};

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "help", usage: "/help", description: "show this help" },
  { name: "providers", usage: "/providers", description: "list providers" },
  { name: "provider", usage: "/provider [id]", description: "switch provider", requiresArgument: true },
  { name: "model", usage: "/model [id]", description: "list or switch model" },
  { name: "apps", usage: "/apps", description: "list connectable apps" },
  { name: "install", usage: "/install <app>", description: "open app details", requiresArgument: true },
  { name: "projects", usage: "/projects", description: "list projects" },
  { name: "project", usage: "/project <id>", description: "switch project", requiresArgument: true },
  { name: "permissions", usage: "/permissions [ask|full-access]", description: "show or change command access" },
  { name: "profile", usage: "/profile [status|diff|catalog|check|push]", description: "show or sync profile" },
  { name: "agents", usage: "/agents", description: "list agents" },
  { name: "agent", usage: "/agent <id>", description: "select agent", requiresArgument: true },
  { name: "run", usage: "/run <action> [json]", description: "run profile action", requiresArgument: true },
  { name: "settings", usage: "/settings [goal-storage global|workspace]", description: "show or update settings" },
  { name: "logs", usage: "/logs", description: "show recent events" },
  { name: "compact", usage: "/compact", description: "compact current session" },
  { name: "clear", usage: "/clear", description: "clear terminal transcript" },
  { name: "exit", usage: "/exit", description: "exit" },
  { name: "hooks", usage: "/hooks", description: "show hook status" },
  { name: "start", usage: "/start", description: "start a new session" },
];

export function parseSlashCommand(text: string): SlashCommand | null {
  if (!text.startsWith("/")) return null;
  const [rawCommand = "", ...rest] = text.slice(1).trim().split(/\s+/);
  const command = rawCommand.toLowerCase();
  if (!command) return null;
  if (command === "exit" || command === "quit") return { type: "exit" };
  if (command === "help") return { type: "help" };
  if (command === "clear") return { type: "clear" };
  if (command === "agents") return { type: "agents" };
  if (command === "apps") return { type: "apps" };
  if (command === "agent") return { type: "agent", id: rest.join(" ").trim() };
  if (command === "install") return { type: "install", id: rest.join(" ").trim() };
  if (command === "projects") return { type: "projects" };
  if (command === "project") return { type: "project", id: rest.join(" ").trim() };
  if (command === "model") return { type: "model", id: rest.join(" ").trim() || null };
  if (command === "permissions") return { type: "permissions", args: rest };
  if (command === "profile") return { type: "profile", args: rest };
  if (command === "logs") return { type: "logs" };
  if (command === "providers") return { type: "providers" };
  if (command === "provider") return { type: "provider", id: rest.join(" ").trim() || null };
  if (command === "compact") return { type: "compact" };
  if (command === "hooks") return { type: "hooks" };
  if (command === "start") return { type: "start" };
  if (command === "run") {
    const action = rest[0] ?? "";
    const rawInput = rest.slice(1).join(" ").trim();
    if (!rawInput) return { type: "run", action, input: undefined };
    return { type: "run", action, input: JSON.parse(rawInput) };
  }
  if (command === "settings") return { type: "settings", args: rest };
  return { type: "unknown", command };
}

export function parseDirectCommandPrompt(text: string): ParsedDirectCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const command = trimmed.slice(1).trim();
  return command ? { command } : null;
}

export function helpText(): string {
  const usageWidth = Math.max(...SLASH_COMMANDS.map((command) => command.usage.length));
  return ["Commands:", ...SLASH_COMMANDS.map((command) => `${command.usage.padEnd(usageWidth + 2)}${command.description}`)].join("\n");
}
