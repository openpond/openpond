import type { ConnectedAppMentionOption } from "./connected-app-mentions";

export const SUBMIT_ISSUE_REPOSITORY = "openpond/openpond";
const GITHUB_ISSUE_WRITE_CAPABILITY = "github.issue.write";

export type SubmitIssueFormInput = {
  title: string;
  description: string;
};

export function hasGitHubIssueSubmitConnection(
  options: ConnectedAppMentionOption[],
): boolean {
  return options.some((option) =>
    option.provider === "github" &&
    (option.ref.capabilities ?? []).includes(GITHUB_ISSUE_WRITE_CAPABILITY),
  );
}

export function formatSubmitIssueFormInput(input: SubmitIssueFormInput): string {
  return [
    `Title: ${input.title.trim()}`,
    "",
    "Description:",
    input.description.trim(),
  ].join("\n");
}

export function buildSubmitIssueSlashPrompt(issueRequest: string): string {
  const request = issueRequest.trim();
  return [
    `@github Submit this request as a new GitHub issue in ${SUBMIT_ISSUE_REPOSITORY}.`,
    `Use the GitHub connected app write operation github.issue.create with input.repo set to ${SUBMIT_ISSUE_REPOSITORY}, a concise title, and a complete issue body that preserves the request.`,
    "This slash command is the user's explicit intent to create the issue.",
    "Before creating, search open issues in the repository for an obvious duplicate. If a clear duplicate exists, do not create a new issue; report the existing issue instead.",
    "",
    `Issue request:\n${request}`,
  ].join("\n");
}
