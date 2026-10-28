export * from "@openpond/local-server/tool-learning";
import { OpenPondToolLearningClient } from "openpond-sdk/tool-learning";
import { hostedTrainingAccount } from "../hosted-training-account";
import { optionString } from "../common/options";
import type {
  ToolLearningOptions,
  ToolLearningCredentialRecord,
} from "@openpond/local-server/tool-learning";

export async function toolLearningOwner(
  options: ToolLearningOptions,
  record: ToolLearningCredentialRecord,
) {
  if (optionString(options, "teamId") && optionString(options, "teamId") !== record.teamId)
    throw new Error("The selected workspace differs from this installation.");
  if (optionString(options, "projectId") && optionString(options, "projectId") !== record.projectId)
    throw new Error("The selected Model Project differs from this installation.");
  const { context, baseUrl } = await hostedTrainingAccount({
    ...options,
    teamId: record.teamId,
    apiBaseUrl: record.apiOrigin,
    account: optionString(options, "account") || record.ownerAccount || "",
  });
  return new OpenPondToolLearningClient({
    baseUrl,
    apiKey: context.token,
    teamId: record.teamId,
    projectId: record.projectId,
  });
}
