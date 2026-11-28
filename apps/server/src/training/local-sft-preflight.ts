import { mkdir } from "node:fs/promises";
import path from "node:path";
import { LocalSftPreflightReportSchema, LocalSftPreflightSchema } from "@openpond/contracts/resource-setup";
import type { SqliteStore } from "../store/store.js";
import { LocalSftReviewError, readLocalSftApproval } from "./local-sft-review.js";
import { localSftWorkerSource } from "./local-sft-worker-source.js";
import { localTrainingModelAssets } from "./local-training-model-assets.js";
import { runLocalTrainingPython } from "./local-training-runtime.js";

export async function loadLocalSftSessionApproval({ store, storeDir, planHash, sessionId, signal }: {
  store: SqliteStore;
  storeDir: string;
  planHash: string;
  sessionId: string;
  signal?: AbortSignal;
}) {
  const ownerId = await store.localResourceOwnerId();
  const { approval, trainingData } = await readLocalSftApproval(storeDir, ownerId, planHash, signal);
  if (approval.request.sessionId !== sessionId || !await store.getSession(sessionId)) {
    throw new LocalSftReviewError("Open the original Model chat to access this approval.", 404);
  }
  return { approval, trainingData };
}

export async function localSftWorkerInputs(storeDir: string, record: Awaited<ReturnType<typeof loadLocalSftSessionApproval>>, signal?: AbortSignal) {
  const { approval, trainingData } = record;
  const assets = localTrainingModelAssets(storeDir);
  const { modelDirectory, base } = await assets.verify(approval.request.modelAssetId, signal);
  const { recipe } = approval.request;
  if (base.preference.modelId !== recipe.baseModel.id || base.preference.revision !== recipe.baseModel.revision ||
    base.preference.tokenizerRevision !== recipe.baseModel.tokenizerRevision ||
    base.preference.chatTemplateHash !== recipe.baseModel.chatTemplateHash) {
    throw new LocalSftReviewError("The saved approval references a different checkpoint or tokenizer.", 409);
  }
  return { modelDirectory, recipe, trainingData, trainingDataHash: approval.trainingDataHash,
    rowCount: approval.rowCount, chatTemplateHash: recipe.baseModel.chatTemplateHash };
}

export async function preflightLocalSft(request: Parameters<typeof loadLocalSftSessionApproval>[0]) {
  const { storeDir, planHash, signal } = request;
  const approval = await loadLocalSftSessionApproval(request);
  if (process.platform !== "linux") return { planHash, report: { status: "unsupported_platform" } } as const;
  const input = await localSftWorkerInputs(storeDir, approval, signal);
  const { recipe } = input;
  const runRoot = path.join(storeDir, "training", "local-sft", "runs");
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  try {
    const report = LocalSftPreflightReportSchema.parse(await runLocalTrainingPython(storeDir, localSftWorkerSource, {
      timeout: Math.min(5 * 60_000, recipe.resourceLimits.wallTimeMs),
      signal,
      input: { ...input, deviceLock: path.join(runRoot, "device.lock") },
    }));
    if (report.tokens && report.tokens.rowCount !== input.rowCount ||
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
