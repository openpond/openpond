import type { ComposerSlashCommand } from "./composer-slash-commands";
import { buildSubmitIssueSlashPrompt } from "./submit-issue-command";

export type RightChatCommandPolicy =
  | { kind: "open_insights" }
  | { kind: "open_training"; objective: string | null }
  | { kind: "send_prompt"; prompt: string; requiresInstructions: boolean };

/**
 * Every command exposed by the side-chat composer has one deliberate behavior.
 * Keeping this switch exhaustive prevents a newly added command from silently
 * degrading into a generic goal prompt.
 */
export function rightChatCommandPolicy(
  command: ComposerSlashCommand,
  prompt: string,
): RightChatCommandPolicy {
  const args = prompt.trim();
  switch (command.id) {
    case "create":
      return { kind: "send_prompt", prompt: `/create ${args}`, requiresInstructions: true };
    case "edit":
      return { kind: "send_prompt", prompt: `/edit ${args}`, requiresInstructions: true };
    case "skill":
      return { kind: "send_prompt", prompt: `/skill ${args}`, requiresInstructions: false };
    case "goal":
    case "goal-local":
      return { kind: "send_prompt", prompt: `Goal: ${args}`, requiresInstructions: true };
    case "goal-remote":
      return { kind: "send_prompt", prompt: `/goal-remote ${args}`, requiresInstructions: true };
    case "insights":
      return { kind: "open_insights" };
    case "train":
      return { kind: "open_training", objective: args || null };
    case "submit-issue":
      return {
        kind: "send_prompt",
        prompt: buildSubmitIssueSlashPrompt(args),
        requiresInstructions: true,
      };
    case "sync-cloud":
      return { kind: "send_prompt", prompt: `/sync-cloud ${args}`, requiresInstructions: false };
  }
}
