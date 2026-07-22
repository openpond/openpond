import type { ChatProvider } from "@openpond/contracts";

const PROFILE_SKILL_SUBCOMMANDS = new Set(["create", "edit", "help", "list"]);

export function skillPromptForComposer(args: string, provider: ChatProvider): string {
  return provider === "codex"
    ? codexSkillPromptForComposer(args)
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

export function codexSkillPromptForComposer(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) {
    return "$skill-creator Help me create or update a personal Codex skill from this conversation. Ask only for details that are not already clear from the thread.";
  }
  const [subcommand = "", ...rest] = trimmed.split(/\s+/);
  const details = rest.join(" ").trim();
  switch (subcommand.toLowerCase()) {
    case "list":
      return "List my personal Codex skills from ~/.codex/skills, including whether each package has scripts or assets.";
    case "help":
      return "$skill-creator Explain how personal Codex skills work, when to use a skill instead of an agent, and the create/edit commands available here.";
    case "edit":
      return `$skill-creator Update a personal Codex skill using this conversation as context.${details ? ` Requested change: ${details}` : " Ask which skill and change I want."}`;
    case "create":
      return `$skill-creator Create a personal Codex skill using this conversation as source material.${details ? ` Requirements: ${details}` : " Infer the reusable workflow from the thread and ask only for missing details that materially change it."}`;
    default:
      return `$skill-creator Create a personal Codex skill using this conversation as source material. Requirements: ${trimmed}`;
  }
}
