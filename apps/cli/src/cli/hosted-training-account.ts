import { loadOpenPondAccountContext } from "@openpond/runtime";
import { optionString } from "./common/options";
import { resolveApiBaseUrlOption } from "./common/urls";

export async function hostedTrainingAccount(options: Record<string, string | boolean>) {
  const context = await accountContext(options);
  if (!context.token)
    throw new Error("Sign in to an OpenPond account before using hosted training.");
  const baseUrl = resolveApiBaseUrlOption(options) ?? context.apiBaseUrl;
  if (new URL(baseUrl).origin !== new URL(context.apiBaseUrl).origin)
    throw new Error("The hosted API URL must match the signed-in account’s API origin.");
  const teamId = optionString(options, "teamId");
  if (!teamId) throw new Error("Hosted training requires --team-id <workspace-id>.");
  const headers = new Headers({ "x-openpond-team-id": teamId });
  if (context.token.startsWith("opk_")) {
    headers.set("Authorization", `ApiKey ${context.token}`);
    headers.set("openpond-api-key", context.token);
  } else headers.set("Authorization", `Bearer ${context.token}`);
  return { context: { ...context, token: context.token }, baseUrl, teamId, headers };
}

async function accountContext(options: Record<string, string | boolean>) {
  // Credential-store reconciliation can briefly overlap another CLI or app.
  // Retry only this local read; never automatically repeat a paid submission.
  for (let attempt = 0; ; attempt++) {
    try {
      return await loadOpenPondAccountContext(optionString(options, "account"));
    } catch (error) {
      const issue = (error as { issue?: { code?: string } }).issue;
      if (issue?.code !== "STORAGE_BUSY" || attempt >= 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
