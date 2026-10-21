import { expect, test } from "vitest";
import { canonicalSha256 } from "openpond-sdk/training";
import { resolveHostedModelRecovery } from "./hosted-model-recovery.js";

// A recovery with no new public submission must inherit only its authenticated
// source's exact checkpoint and approval, never another Model's source or weights.
test("resolves exact recovery provenance while rejecting substituted source and checkpoint identities", async () => {
  const H = "a".repeat(64), B = "b".repeat(64);
  const manifest = { id: "manifest", contentHash: H }, taskset = { id: "taskset", contentHash: H };
  const submission = { source: { harnessRunManifest: manifest, taskset } };
  const source = { job: { id: "source", teamId: "team", modelProjectId: "hosted-model", portableProjectId: "model",
    sourceProjectRevision: 6, inputBundleSha256: H, publicSubmission: submission },
    checkpoints: [{ id: "checkpoint", state: "ready", policyVersion: 1, adapterSha256: H, resumeSha256: B }] };
  const content = { sourceJobId: "source", sourceInputManifestSha256: H, checkpointId: "checkpoint",
    checkpointPolicyVersion: 1, completedGroups: 1, adapterSha256: H, resumeSha256: B,
    approvedManifest: manifest, evaluationTaskset: taskset };
  const recovery = { ...content, receiptSha256: await canonicalSha256(content) };
  const job = { id: "replacement", teamId: "team", modelProjectId: "hosted-model", portableProjectId: null,
    sourceProjectRevision: null, publicSubmission: null, inputBundleSha256: B, inputBundle: { recovery } };
  const commands = ["materialize_checkpoint", "start_inference"].map(commandType => ({ commandType, state: "succeeded" }));
  const resolveSource = async (id: string) => { expect(id).toBe("source"); return source; };
  const resolved = await resolveHostedModelRecovery({ job, commands, resolveSource });
  expect(resolved).toMatchObject({ portableProjectId: "model", sourceProjectRevision: 6, publicSubmission: null,
    recoveryImport: { executionSubmissionHash: B, sourceSubmission: submission, optimizerStateRestored: true } });
  source.job.teamId = "foreign";
  await expect(resolveHostedModelRecovery({ job, commands, resolveSource })).rejects.toThrow("exact source run and checkpoint");
  source.job.teamId = "team";
  source.checkpoints[0]!.adapterSha256 = B;
  await expect(resolveHostedModelRecovery({ job, commands, resolveSource })).rejects.toThrow("exact source run and checkpoint");
  source.checkpoints[0]!.adapterSha256 = H;
  job.inputBundle.recovery.receiptSha256 = B;
  await expect(resolveHostedModelRecovery({ job, commands, resolveSource })).rejects.toThrow("receipt identity changed");
  expect(job.publicSubmission).toBeNull();
});
