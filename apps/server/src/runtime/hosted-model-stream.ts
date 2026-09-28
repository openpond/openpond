import { streamOpChatChatCompletion, type HostedChatTurnInput } from "@openpond/runtime";

/** Bind every hosted model call to the credential and model selected by the host. */
export function createHostedModelStreamFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const token = environment.OPENPOND_API_KEY?.trim();
  const apiBaseUrl = environment.OPENPOND_OPCHAT_API_URL?.trim();
  const admittedModel = environment.OPENPOND_HOSTED_MODEL_ID?.trim();
  if (!token || !apiBaseUrl || !admittedModel) {
    throw new Error("Hosted model stream requires a host credential, API URL, and admitted model.");
  }
  const url = new URL(apiBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Hosted model stream API URL is invalid.");
  }
  return async function* streamHostedModel(input: HostedChatTurnInput) {
    if (input.model !== admittedModel) {
      throw new Error("Hosted model selection changed outside host admission.");
    }
    yield* streamOpChatChatCompletion({
      ...input, apiBaseUrl: url.toString(), token, model: admittedModel,
    });
  };
}
