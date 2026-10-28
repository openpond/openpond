export function codexPromptWithHarnessContext(userPrompt: string, harnessContext: string): string {
  if (!harnessContext.trim()) return userPrompt;
  return [
    "<openpond_trusted_runtime_context>",
    harnessContext,
    "</openpond_trusted_runtime_context>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n");
}
