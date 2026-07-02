import type { Session } from "@openpond/contracts";

const WORKSPACE_KINDS_REQUIRING_TOOLS = new Set([
  "local_project",
  "sandbox",
  "sandbox_template",
]);

const EXPLICIT_WORKSPACE_TOOL_PATTERN =
  /\b(?:sandbox_(?:delete_file|edit_file|exec|git_[a-z_]+|list_files|mkdir|move_file|read_file|search_files|status|upload_file|write_file)|delete_file|edit_file|list_files|read_files|search_files|workspace_status|write_file|write_files)\b/i;

const WORKSPACE_MUTATION_PATTERN =
  /\b(?:add|append|change|create|delete|edit|fix|modify|move|patch|remove|rename|replace|save|touch|update|write)\b/i;

const WORKSPACE_READ_PATTERN =
  /\b(?:cat|check|inspect|list|open|read|search|show|view)\b/i;

const FILE_REFERENCE_PATTERN =
  /\b(?:codebase|directory|file|files|folder|openpond\.ya?ml|package\.json|path|readme|repo|repository|source|tsconfig|workspace)\b|(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.[a-z0-9]{1,12}\b/i;

const CONCEPTUAL_QUESTION_PATTERN =
  /^\s*(?:can you explain|could you explain|explain|how do i|how should i|should i|should we|what are|what is|why)\b/i;

export function requiresWorkspaceToolForPrompt(
  session: Pick<Session, "workspaceKind">,
  prompt: string,
): boolean {
  if (!session.workspaceKind || !WORKSPACE_KINDS_REQUIRING_TOOLS.has(session.workspaceKind)) {
    return false;
  }

  if (EXPLICIT_WORKSPACE_TOOL_PATTERN.test(prompt)) {
    return true;
  }

  if (CONCEPTUAL_QUESTION_PATTERN.test(prompt)) {
    return false;
  }

  if (!FILE_REFERENCE_PATTERN.test(prompt)) {
    return false;
  }

  return WORKSPACE_MUTATION_PATTERN.test(prompt) || WORKSPACE_READ_PATTERN.test(prompt);
}
