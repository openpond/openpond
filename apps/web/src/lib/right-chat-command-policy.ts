import type { ComposerSlashCommand } from "./composer-slash-commands";
import { buildSubmitIssueSlashPrompt } from "./submit-issue-command";

export type RightChatCommandPolicy =
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
    case "agent":
      return { kind: "send_prompt", prompt: `/agent ${args}`, requiresInstructions: true };
    case "skill":
      return { kind: "send_prompt", prompt: `/skill ${args}`, requiresInstructions: false };
    case "goal":
      return { kind: "send_prompt", prompt: `/goal ${args}`, requiresInstructions: true };
    case "workflow":
      return {
        kind: "send_prompt",
        prompt: [
          "Create a scheduled workflow attached to this chat.",
          "Use the schedule_work tool after resolving the exact cadence, local date/time, and timezone from my request. Ask a concise clarification only if a required scheduling detail is genuinely missing.",
          `Workflow request: ${args}`,
        ].join("\n\n"),
        requiresInstructions: true,
      };
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
