import { deterministicTrainingRewardSource } from "openpond-sdk/training";
import { recordOrEmpty } from "./openpond-managed-training-adapter-projection.js";

/** Consume the same verified bundle bytes that will be staged for admission. */
export async function managedTrainingGradingSource(files: Array<{ path: string; content: string }>) {
  const gradersFile = files.find(file => file.path === "graders.json");
  if (!gradersFile) throw new Error("Managed training requires its immutable grader set.");
  const gradersPackage = recordOrEmpty(JSON.parse(Buffer.from(gradersFile.content, "base64").toString("utf8")));
  const bindingFile = files.find(file => file.path === "reward-binding.json");
  const boundReward = bindingFile
    ? recordOrEmpty(JSON.parse(Buffer.from(bindingFile.content, "base64").toString("utf8")))
    : null;
  return deterministicTrainingRewardSource({
    graders: gradersPackage.graders,
    rewardExecution: boundReward ? { binding: boundReward.binding, rewards: boundReward.rewards } : null,
  });
}
