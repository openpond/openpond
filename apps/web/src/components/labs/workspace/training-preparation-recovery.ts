import { canonicalJson, parseAndVerifyTrainingExperimentSetupReceipt, parseAndVerifyTrainingPreparationReceipt,
  type TrainingExperimentSetupRequest } from "openpond-sdk/training";

export type RetainedTrainingPreparation = {
  snapshot: string;
  request: TrainingExperimentSetupRequest;
  acknowledge: () => Promise<void>;
};

/** Resolve uncertain staging before consulting catalogs for edited inputs.
 * A submitted Job is never cancelled or replaced by this preparation recovery. */
export async function reconcileChangedTrainingPreparation(input: {
  retained: RetainedTrainingPreparation;
  snapshot: string;
  request: (command: string, body: unknown) => Promise<unknown>;
}): Promise<{ kind: "unchanged" } | { kind: "cancelled" } | { kind: "submitted"; jobId: string }> {
  const retained = input.retained;
  if (retained.snapshot === input.snapshot) return { kind: "unchanged" };
  const wrapper = await parseAndVerifyTrainingExperimentSetupReceipt(await input.request("prepare-draft", retained.request));
  if (canonicalJson(wrapper.request) !== canonicalJson(retained.request))
    throw new Error("The recovered preparation does not match its retained inputs.");
  let receipt = wrapper.preparation;
  if (receipt.state === "prepared") {
    const cancelled = await parseAndVerifyTrainingPreparationReceipt(await input.request("cancel", {
      id: receipt.plan.id, control: { teamId: retained.request.teamId, planHash: receipt.plan.contentHash, expectedRevision: receipt.revision },
    }));
    if (cancelled.plan.contentHash !== receipt.plan.contentHash || cancelled.plan.id !== receipt.plan.id ||
      cancelled.revision <= receipt.revision || cancelled.state !== "cancelled")
      throw new Error("The earlier preparation has not confirmed cancellation. Retry its retained request.");
    receipt = cancelled;
  }
  await retained.acknowledge();
  return receipt.state === "submitted" && receipt.jobId
    ? { kind: "submitted", jobId: receipt.jobId }
    : { kind: "cancelled" };
}
