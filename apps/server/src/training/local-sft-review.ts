import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Taskset } from "@openpond/contracts";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";
import { LocalSftApprovalSchema, LocalSftReviewSchema, type LocalSftReviewRequest, type LocalTrainingModelBase } from "@openpond/contracts/resource-setup";
import { contentHash, sha256 } from "@openpond/harness";
import { projectInlineTrainingData } from "@openpond/training-sdk";
import { publishTasksetDraft } from "@openpond/taskset-sdk";
import { compileTasksetDraftWorkspace } from "openpond-sdk/dataset-workspaces";
import type { SqliteStore } from "../store/store.js";
import { localTrainingModelAssets } from "./local-training-model-assets.js";

const localTrainingApproval = z.object({
  approval: LocalSftApprovalSchema,
  ownerId: z.string().min(1),
  trainingData: z.string(),
}).strict();
const text = z.string().refine(value => value.trim().length > 0);
const prompt = z.object({ prompt: text }).strict();
const target = z.object({ text }).strict();

export class LocalSftReviewError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function eligibleSources(taskset: Taskset) {
  return new Set(taskset.sourceRefs.filter(source =>
    source.secretScanStatus === "passed" && source.piiScanStatus === "passed" && source.licensingStatus === "approved" &&
    (!("consent" in source) || source.consent.status === "granted" && source.consent.scope !== "metadata_only"),
  ).map(source => source.id));
}

function verifyRecipe(request: LocalSftReviewRequest, base: LocalTrainingModelBase) {
  const { recipe } = request;
  const selected = base.preference;
  if (recipe.baseModel.id !== selected.modelId || recipe.baseModel.revision !== selected.revision ||
    recipe.baseModel.tokenizerRevision !== selected.tokenizerRevision || recipe.baseModel.chatTemplateHash !== selected.chatTemplateHash) {
    throw new LocalSftReviewError("The recipe references a different checkpoint or tokenizer.", 409);
  }
  if (!recipe.dataset.completionOnly || recipe.dataset.maxExamples > 1_000) {
    throw new LocalSftReviewError("Choose completion-only SFT with at most 1,000 training examples.");
  }
}

export async function reviewLocalSft(input: {
  store: SqliteStore;
  storeDir: string;
  request: LocalSftReviewRequest;
  expectedPlanHash?: string;
  signal?: AbortSignal;
}) {
  const { store, storeDir, request, expectedPlanHash, signal } = input;
  const assets = localTrainingModelAssets(storeDir);
  const [ownerId, session, dataset, base] = await Promise.all([
    store.localResourceOwnerId(),
    store.getSession(request.sessionId),
    store.readLocalDataset(request.dataset.id, request.dataset.revision),
    assets.inspect(request.modelAssetId),
  ]);
  const draft = SessionResourceDraftSchema.safeParse(session?.metadata?.resourceDraft);
  if (!session || session.systemKind || session.workspaceKind === "sandbox" || !draft.success || draft.data.kind !== "model") {
    throw new LocalSftReviewError("Open the original Model setup chat to review this run.", 404);
  }
  if (!dataset || dataset.ownerId !== ownerId || dataset.workspace.contentHash !== request.dataset.contentHash) {
    throw new LocalSftReviewError("The exact local Dataset revision is unavailable.", 409);
  }
  verifyRecipe(request, base);
  const source = dataset.workspace.draft;
  if (source.datasetArtifact || source.environment.kind !== "chat" || source.environment.toolNames.length) {
    throw new LocalSftReviewError("Choose a local Dataset with inline text prompts and targets.");
  }
  const published = publishTasksetDraft({ draft: source, now: source.updatedAt, sourcePackageHash: dataset.workspace.contentHash });
  if (published.metadata.learning !== undefined) {
    throw new LocalSftReviewError("Choose a Dataset with authored text targets for this review.");
  }
  const sources = eligibleSources(published);
  const eligible = published.tasks.filter(task => task.split === "train" && !task.assets?.length &&
    !Object.keys(task.policyVisibleContext).length && task.sourceRefs.every(sourceId => sources.has(sourceId)) &&
    prompt.safeParse(task.input).success && target.safeParse(task.expectedOutput).success);
  const projected = projectInlineTrainingData({
    ...published,
    tasks: eligible,
    learningSignals: {
      ...published.learningSignals,
      demonstrations: eligible.map(task => ({
        kind: "demonstration", id: `local-review-${contentHash(task.id)}`, taskId: task.id, approved: true,
        prompt: null, response: JSON.stringify(task.expectedOutput), confidence: 1, artifactRef: published.id,
        sourceRefs: task.sourceRefs, metadata: {},
      })),
    },
  }, request.recipe, sources);
  if (!projected.exampleCount) throw new LocalSftReviewError("The train split has no eligible text prompts with expected answers.");
  const pkg = compileTasksetDraftWorkspace({
    workspace: dataset.workspace, preparation: null,
    adapterId: "openpond-desktop-taskset-authoring-v1", now: source.updatedAt, maximumBytes: Number.POSITIVE_INFINITY,
  });
  const content = {
    request, datasetName: source.name, datasetPackageHash: pkg.contentHash,
    trainingDataHash: projected.contentHash, taskIdsHash: projected.taskIdsHash,
    rowCount: projected.exampleCount, eligibleRows: eligible.length,
    excludedRows: published.tasks.filter(task => task.split === "train").length - eligible.length,
  };
  const plan = { ...content, planHash: contentHash({ ownerId, ...content }) };
  signal?.throwIfAborted();
  if (!expectedPlanHash) {
    const rows = projected.content.trimEnd().split("\n").map(line => {
      const row = JSON.parse(line);
      return { id: row.id, prompt: prompt.parse(row.input).prompt, target: target.parse(row.expectedOutput).text };
    });
    return LocalSftReviewSchema.parse({ plan, rows });
  }
  if (expectedPlanHash !== plan.planHash) {
    throw new LocalSftReviewError("The training inputs changed. Review the selected examples again.", 409);
  }
  await assets.verify(request.modelAssetId, signal);
  return saveApproval(storeDir, { approval: { ...plan, approvedAt: new Date().toISOString() }, ownerId, trainingData: projected.content }, signal);
}

async function saveApproval(storeDir: string, record: z.infer<typeof localTrainingApproval>, signal?: AbortSignal) {
  const directory = path.join(storeDir, "training", "local-sft", "approvals");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${record.approval.planHash}.json`);
  const staging = path.join(directory, `.${randomUUID()}.json`);
  try {
    await writeFile(staging, JSON.stringify(record), { mode: 0o600, flag: "wx", flush: true, signal });
    signal?.throwIfAborted();
    try { await link(staging, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return (await readLocalSftApproval(storeDir, record.ownerId, record.approval.planHash, signal)).approval;
    }
    return record.approval;
  } finally { await rm(staging, { force: true }); }
}

export async function readLocalSftApproval(storeDir: string, ownerId: string, planHash: string, signal?: AbortSignal) {
  const hash = LocalSftApprovalSchema.shape.planHash.parse(planHash);
  try {
    const saved = await readFile(path.join(storeDir, "training", "local-sft", "approvals", `${hash}.json`), { encoding: "utf8", signal });
    const record = localTrainingApproval.parse(JSON.parse(saved));
    const { approvedAt: _time, planHash: expected, ...content } = record.approval;
    if (record.ownerId === ownerId && expected === hash && contentHash({ ownerId, ...content }) === hash &&
      sha256(record.trainingData) === record.approval.trainingDataHash) return record;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalSftReviewError("The local training approval is unavailable.", 404);
  }
  throw new LocalSftReviewError("The saved training approval failed verification.", 409);
}
