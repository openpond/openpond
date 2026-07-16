import type { Command } from "./common";
import { parseBooleanOption } from "./common/options";

export type CliTopLevelAction =
  | "check-update"
  | "command"
  | "help"
  | "tui"
  | "ui"
  | "version";

export function resolveCliTopLevelAction(input: {
  command: Command;
  options: Record<string, string | boolean>;
}): CliTopLevelAction {
  if (!input.command && parseBooleanOption(input.options.version)) return "version";
  if (parseBooleanOption(input.options.checkUpdate)) return "check-update";
  if (!input.command && parseBooleanOption(input.options.help)) return "help";
  if (!input.command && parseBooleanOption(input.options.tui)) return "tui";
  if (!input.command) return "ui";
  return "command";
}
