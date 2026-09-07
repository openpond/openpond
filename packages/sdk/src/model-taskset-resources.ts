import { z } from "zod";
import { EnvironmentReleaseSchema, VerifierSetReleaseSchema, verifyEnvironmentRelease, verifyVerifierSetRelease } from "@openpond/evals";
import { createLearningTextAsset, sealLearningContent, verifyLearningTextAsset, type LearningTextAsset } from "@openpond/evals/learning";
import type { TasksetRelease } from "@openpond/evals/tasksets";
import { canonicalJson } from "./protocol.js";

export const ModelTasksetExecutionResourcesSchema = z.object({ environment: EnvironmentReleaseSchema, verifierSet: VerifierSetReleaseSchema }).strict();
type Resources = z.infer<typeof ModelTasksetExecutionResourcesSchema>;
type Context = Pick<TasksetRelease, "environmentRelease" | "verifierSetRelease" | "environment" | "graders">;

/** Private resource identity follows the exact published execution references. */
export function modelTasksetExecutionResourcesAssetId(context: Pick<Context, "environmentRelease" | "verifierSetRelease">): string {
  if (!context.environmentRelease || !context.verifierSetRelease) throw new Error("Taskset execution references are missing.");
  return `taskset-execution-${sealLearningContent({ environment: context.environmentRelease, verifiers: context.verifierSetRelease }).contentHash}`;
}

export function createModelTasksetExecutionResourcesAsset(value: Resources): LearningTextAsset {
  const resources = ModelTasksetExecutionResourcesSchema.parse({ environment: value.environment, verifierSet: value.verifierSet });
  assertIntegrity(resources);
  const id = modelTasksetExecutionResourcesAssetId({ environmentRelease: { id: resources.environment.id, contentHash: resources.environment.contentHash }, verifierSetRelease: { id: resources.verifierSet.id, contentHash: resources.verifierSet.contentHash } });
  const { contentHash: _hash, ...asset } = createLearningTextAsset({ text: canonicalJson(resources), path: "environment/resources.json", mediaType: "application/json", visibility: "host_private" });
  return sealLearningContent({ ...asset, id, asset: { ...asset.asset, id } });
}

/** Resolve text or tool execution resources without trusting an asset's ID alone. */
export function resolveModelTasksetExecutionResourcesAsset(context: Context, asset: LearningTextAsset): Resources {
  if (asset.id !== modelTasksetExecutionResourcesAssetId(context) || asset.asset.visibility !== "host_private" || asset.asset.mediaType !== "application/json") throw new Error("Taskset execution asset differs from its published references.");
  const resources = ModelTasksetExecutionResourcesSchema.parse(JSON.parse(verifyLearningTextAsset(asset, asset.asset)));
  assertIntegrity(resources);
  if (asset.id !== createModelTasksetExecutionResourcesAsset(resources).id || canonicalJson(context.environment) !== canonicalJson(resources.environment.contract) || canonicalJson(context.graders) !== canonicalJson(resources.verifierSet.graders)) throw new Error("Taskset differs from its execution resources.");
  return resources;
}

function assertIntegrity(resources: Resources): void {
  if (!verifyEnvironmentRelease(resources.environment) || !verifyVerifierSetRelease(resources.verifierSet)) throw new Error("Taskset execution resource integrity failed.");
}
