import { learningRef, OpenPondLearningError, type OpenPondCorrectionMetricsClient, type OpenPondLearningClient } from "openpond-sdk/learning";
import type { HostedModelProjectSummary } from "openpond-sdk/model-projects";
import { optionString, parseIntegerOption } from "./common/options";

/** Explicit read-only inspections use the hosted command's existing account,
 * transport and exact workspace. They cannot publish a policy, grade, reserve
 * money, submit training or change an execution/provisioning pause. */
export async function inspectHostedLearning(input: {
  action: "hosted-corrections" | "hosted-learning-inspect";
  options: Record<string, string | boolean>;
  teamId: string;
  model: HostedModelProjectSummary;
  learning: OpenPondLearningClient;
  corrections: OpenPondCorrectionMetricsClient;
}) {
  if (input.model.teamId !== input.teamId)
    throw new OpenPondLearningError(502, "model_scope_mismatch", "The Model did not match the requested workspace.", null);
  const runId = optionString(input.options, "runId");
  if (input.action === "hosted-corrections") {
    if (optionString(input.options, "cursor") || input.options.limit !== undefined)
      throw new Error("hosted-corrections reads one Model/run metric snapshot; use hosted-learning-inspect for paged policies.");
    return input.corrections.read({ teamId: input.teamId, modelId: input.model.id, ...(runId ? { runId } : {}) });
  }
  if (runId) throw new Error("--run-id is only supported by hosted-corrections.");
  const limit = parseIntegerOption(input.options.limit, "--limit") ?? 25;
  if (limit < 1 || limit > 100) throw new Error("--limit must be between 1 and 100.");
  const afterId = optionString(input.options, "cursor");
  const page = await input.learning.list("policy", { parentId: input.model.portableProjectId, limit, ...(afterId ? { afterId } : {}) });
  const policies = [];
  for (const policy of page.items) policies.push({ policy, inspection: await input.learning.inspectPolicy(learningRef(policy)) });
  return {
    model: { id: input.model.id, portableProjectId: input.model.portableProjectId, revision: input.model.revision, etag: input.model.etag },
    taskQueue: await input.learning.inspectTaskQueue(input.model.portableProjectId),
    policies: { items: policies, nextCursor: page.nextCursor },
  };
}
