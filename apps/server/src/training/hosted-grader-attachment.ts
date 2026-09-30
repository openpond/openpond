import { contentHash } from "@openpond/harness";
import { OpenPondLearningClient, RewardReleaseRefSchema, createRewardBinding, learningRef, verifyLearningTextAsset } from "openpond-sdk/learning";
import { projectLearningBatchGraders } from "openpond-sdk/taskset-packages";
import { createTasksetDraftWorkspace, saveTasksetDraftWorkspaceDocument } from "openpond-sdk/taskset-drafts";
import type { DatasetWorkspaceReceipt, OpenPondDatasetWorkspaceClient } from "openpond-sdk/dataset-workspaces";
import { z } from "zod";
import { saveRecoveredDatasetWrite } from "./hosted-dataset-recovery.js";
const Request = z.object({ id: z.string().min(1).max(240), expectedRevision: z.number().int().positive(), operationId: z.string().min(1).max(240), now: z.iso.datetime(), release: RewardReleaseRefSchema.nullable(), removeId: z.string().min(1).max(240).optional() }).strict();
/** The shared Reward compiler supplies the implementation and immutable asset
 * identities. Attachment only changes this editable dataset's selected pins. */
export async function attachHostedDatasetGrader(input: { value: unknown; learning: OpenPondLearningClient; datasets: OpenPondDatasetWorkspaceClient; requireDataset: (id: string) => Promise<DatasetWorkspaceReceipt> }) {
  const request = Request.parse(input.value);
  const current = await input.requireDataset(request.id);
  const recovered = await input.datasets.operationResult(request.operationId, { datasetId: request.id, kind: "save" });
  const receipt = recovered?.base ?? current;
  if (receipt.revision !== request.expectedRevision || receipt.workspace.draft.status !== "draft") throw new Error("The editable dataset changed. Refresh before attaching a grader.");
  let graders = receipt.workspace.draft.graders.filter(grader => grader.id !== (request.release?.id ?? request.removeId));
  const files = [...receipt.workspace.files];
  if (request.release) {
    const reward = await input.learning.get("reward", request.release.id, request.release.revision);
    if (reward.contentHash !== request.release.contentHash) throw new Error("The selected grader release differs from its retained content.");
    if (reward.implementation.kind === "human" || reward.implementation.kind === "learned_model") throw new Error("Choose an executable code verifier or calibrated LLM judge.");
    const implementation = reward.implementation;
    const refs = [...reward.assets, "verifierRef" in implementation ? implementation.verifierRef : null, "rubricRef" in implementation ? implementation.rubricRef : null, reward.fixtureSetRef].filter(ref => ref !== null && ref !== undefined).filter((ref, index, all) => all.findIndex(candidate => contentHash(candidate) === contentHash(ref)) === index);
    const assets = await Promise.all(refs.map(ref => input.learning.get("asset", ref.id, 1)));
    const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: `dataset-grader-${contentHash(request.release).slice(0, 32)}`, revision: 1, sources: [{ graderId: reward.id, reward: learningRef(reward), role: "evaluation", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: false, privileged: false, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [reward]);
    const projected = projectLearningBatchGraders(binding, [reward], assets)[0]!;
    graders.push({ ...projected, metadata: { ...projected.metadata, sourceReward: learningRef(reward) } });
    for (const ref of refs) {
      const asset = assets.find(candidate => candidate.id === ref.id)!;
      const bytes = Buffer.from(verifyLearningTextAsset(asset, ref), "utf8");
      const path = projected.kind === "custom_verifier" && "verifierRef" in implementation && ref.id === implementation.verifierRef.id ? projected.module : ref.path;
      const previous = files.find(file => file.path === path);
      if (previous && previous.contentHash !== ref.contentHash) throw new Error(`The dataset already contains different bytes at ${path}.`);
      if (!previous) files.push({ path, contentHash: ref.contentHash, sizeBytes: bytes.length, base64: bytes.toString("base64") });
    }
  } else if (!request.removeId) throw new Error("Choose a grader release to attach or an attachment to remove.");
  const workspace = saveTasksetDraftWorkspaceDocument({ workspace: createTasksetDraftWorkspace({ schemaVersion: receipt.workspace.schemaVersion, draft: receipt.workspace.draft, files }), draft: { ...receipt.workspace.draft, graders }, expectedDraftRevision: receipt.revision, now: request.now });
  return saveRecoveredDatasetWrite(input.datasets, { operationId: request.operationId, expectedRevision: receipt.revision, workspace, ...(receipt.originProjectId ? { originProjectId: receipt.originProjectId } : {}), ...(receipt.ownerScope ? { ownerScope: receipt.ownerScope } : {}) }, recovered);
}
