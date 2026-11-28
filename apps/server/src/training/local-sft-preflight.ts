import { LocalSftPreflightReportSchema, LocalSftPreflightSchema } from "@openpond/contracts/resource-setup";
import type { SqliteStore } from "../store/store.js";
import { LocalSftReviewError, readLocalSftApproval } from "./local-sft-review.js";
import { localSftWorkerSource } from "./local-sft-worker-source.js";
import { localTrainingModelAssets } from "./local-training-model-assets.js";
import { runLocalTrainingPython } from "./local-training-runtime.js";

export async function preflightLocalSft({ store, storeDir, planHash, sessionId, signal }: {
  store: SqliteStore;
  storeDir: string;
  planHash: string;
  sessionId: string;
  signal?: AbortSignal;
}) {
  const ownerId = await store.localResourceOwnerId();
  const { approval, trainingData } = await readLocalSftApproval(storeDir, ownerId, planHash, signal);
  if (approval.request.sessionId !== sessionId || !await store.getSession(sessionId)) {
    throw new LocalSftReviewError("Open the original Model chat to check this approval.", 404);
  }
  if (process.platform !== "linux") return { planHash, report: { status: "unsupported_platform" } } as const;
  const assets = localTrainingModelAssets(storeDir);
  const { modelDirectory, base } = await assets.verify(approval.request.modelAssetId, signal);
  const { recipe } = approval.request;
  if (base.preference.revision !== recipe.baseModel.revision ||
    base.preference.tokenizerRevision !== recipe.baseModel.tokenizerRevision ||
    base.preference.chatTemplateHash !== recipe.baseModel.chatTemplateHash) {
    return { planHash, report: { status: "checkpoint_mismatch" } } as const;
  }
  try {
    const report = LocalSftPreflightReportSchema.parse(await runLocalTrainingPython(storeDir, localSftWorkerSource, {
      timeout: Math.min(5 * 60_000, recipe.resourceLimits.wallTimeMs),
      signal,
      input: { modelDirectory, recipe, trainingData, trainingDataHash: approval.trainingDataHash,
        rowCount: approval.rowCount, chatTemplateHash: recipe.baseModel.chatTemplateHash },
    }));
    if (report.tokens && report.tokens.rowCount !== approval.rowCount ||
      report.status === "ready" && (report.device.usedBytes > report.device.budgetBytes ||
        report.device.budgetBytes > Math.min(report.device.freeBytes, recipe.resourceLimits.memoryBytes) ||
        report.device.freeBytes > report.device.capacityBytes)) {
      throw new Error("The runtime reported different capacity or training inputs.");
    }
    return LocalSftPreflightSchema.parse({ planHash, report });
  } catch (error) {
    signal?.throwIfAborted();
    return { planHash, report: { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "python_missing" : "probe_failed" } } as const;
  }
}
