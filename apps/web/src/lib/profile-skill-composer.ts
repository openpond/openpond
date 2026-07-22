import type { ChatProvider } from "@openpond/contracts";

const PROFILE_SKILL_SUBCOMMANDS = new Set(["create", "edit", "help", "list"]);

export function skillPromptForComposer(
  args: string,
  provider: ChatProvider,
  profileSourcePath: string | null = null,
): string {
  return provider === "codex"
    ? codexProfileSkillPromptForComposer(args, profileSourcePath)
    : profileSkillPromptForComposer(args);
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

export function codexProfileSkillPromptForComposer(
  args: string,
  profileSourcePath: string | null,
): string {
  const trimmed = args.trim();
  const skillsDirectory = profileSourcePath
    ? `${profileSourcePath.replace(/\/$/, "")}/skills`
    : "the active OpenPond profile's skills directory";
  const locationRule = `Store the finished package under ${skillsDirectory}. Do not write it to ~/.codex/skills.`;
  if (!trimmed) {
    return `$skill-creator Create or update an OpenPond profile skill package from this conversation. ${locationRule} Ask only for details that are not already clear from the thread.`;
  }
  const [subcommand = "", ...rest] = trimmed.split(/\s+/);
  const details = rest.join(" ").trim();
  switch (subcommand.toLowerCase()) {
    case "list":
      return `List the OpenPond profile skill packages under ${skillsDirectory}, including whether each package has scripts, references, or assets. Do not list personal Codex skills from ~/.codex/skills.`;
    case "help":
      return `$skill-creator Explain how OpenPond profile skill packages work, when to use a skill instead of an agent, and the create/edit commands available here. ${locationRule}`;
    case "edit":
      return `$skill-creator Update an OpenPond profile skill package using this conversation as context. ${locationRule}${details ? ` Requested change: ${details}` : " Ask which skill and change I want."}`;
    case "create":
      return `$skill-creator Create an OpenPond profile skill package using this conversation as source material. ${locationRule}${details ? ` Requirements: ${details}` : " Infer the reusable workflow from the thread and ask only for missing details that materially change it."}`;
    default:
      return `$skill-creator Create an OpenPond profile skill package using this conversation as source material. ${locationRule} Requirements: ${trimmed}`;
  }
}
