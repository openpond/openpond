import type { ChatProvider } from "@openpond/contracts";

const PROFILE_SKILL_SUBCOMMANDS = new Set(["create", "edit", "help", "list"]);

export function skillPromptForComposer(
  args: string,
  _provider: ChatProvider,
  _profileSourcePath: string | null = null,
): string {
  return profileSkillPromptForComposer(args);
}

export function profileSkillPromptForComposer(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "/skill";
  const [first = ""] = trimmed.split(/\s+/, 1);
  if (PROFILE_SKILL_SUBCOMMANDS.has(first.toLowerCase())) {
    return `/skill ${trimmed}`;
  }
  return `/skill create ${trimmed}`;
}
