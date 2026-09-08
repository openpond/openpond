import { z } from "zod";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";
import { MAX_TASKSET_PACKAGE_BYTES, TasksetPackageSchema, validateTasksetPackage, type TasksetPackage } from "./taskset-package-contracts.js";
import { HostedModelProjectSummarySchema, HostedModelProjectSyncSchema, HostedModelProjectTrainingSetupSchema } from "./model-projects.js";
import { contentHash } from "@openpond/harness";
import { learningRef } from "@openpond/evals/learning";

const IdSchema = z.string().trim().min(1).max(500);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Configuration and package selection share one hosted commit. Package-owned
 * references cannot accidentally contain a Desktop-local content hash. */
export const TasksetPackageModelConfigurationSchema = HostedModelProjectSyncSchema.pick({
  portableProjectId: true, name: true, objective: true, defaultBaseModel: true, defaultDestinationId: true,
  sourceRevision: true, sourceUpdatedAt: true,
}).extend({ trainingSetup: HostedModelProjectTrainingSetupSchema.omit({ tasksetRef: true, rewardBindingRef: true, tasksetRelease: true, recipe: true }) }).strict();
export const TasksetPackagePublicationSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPackagePublication.v1"),
  operationId: IdSchema, modelProjectId: IdSchema, expectedProjectEtag: HashSchema.nullable(),
  name: z.string().trim().min(1).max(200), description: z.string().max(5_000),
  buildIntent: z.enum(["demonstrations", "preferences", "verifiable_reward", "rubric", "discovery"]),
  methodHint: z.enum(["sft", "dpo", "grpo", "ppo"]).nullable(), package: TasksetPackageSchema,
  modelConfiguration: TasksetPackageModelConfigurationSchema.optional(),
  selection: z.enum(["select", "attach"]).optional(),
}).strict().refine(value => value.selection !== "attach" || value.modelConfiguration === undefined, "Attachment-only publication cannot replace Model configuration.");
export const TasksetPackageReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPackageReceipt.v1"),
  teamId: IdSchema, modelProjectId: IdSchema, operationId: IdSchema,
  taskset: TasksetCatalogReleaseRefSchema, packageHash: HashSchema,
  hostedTasksetId: IdSchema, projectEtag: HashSchema,
  project: HostedModelProjectSummarySchema.optional(),
  selection: z.enum(["select", "attach"]).optional(),
}).strict();
export const TasksetPackageReadbackSchema = z.object({
  schemaVersion: z.literal("openpond.tasksetPackageReadback.v1"),
  teamId: IdSchema, modelProjectId: IdSchema, package: TasksetPackageSchema,
}).strict();
export type TasksetPackagePublication = z.infer<typeof TasksetPackagePublicationSchema>;
export type TasksetPackageReceipt = z.infer<typeof TasksetPackageReceiptSchema>;
export type TasksetPackageModelConfiguration = z.infer<typeof TasksetPackageModelConfigurationSchema>;

export class OpenPondTasksetPackageError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondTasksetPackageError"; }
}

/** Private package operations are explicitly scoped to an authorized Model.
 * Catalog inventory remains metadata-only and never calls this client itself. */
export class OpenPondTasksetPackageClient {
  readonly #options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch };
  constructor(options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("Taskset package client requires a clean HTTP(S) endpoint and workspace credentials.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }

  async publish(input: TasksetPackagePublication, options: { signal?: AbortSignal } = {}): Promise<TasksetPackageReceipt> {
    const request = TasksetPackagePublicationSchema.parse(input);
    validateTasksetPackage(request.package);
    const receipt = TasksetPackageReceiptSchema.parse(await this.#request("", "POST", request, options.signal));
    const release = request.package.taskset;
    if (receipt.teamId !== this.#options.teamId || receipt.modelProjectId !== request.modelProjectId || receipt.operationId !== request.operationId
      || receipt.packageHash !== request.package.contentHash || receipt.taskset.id !== release.id || receipt.taskset.revision !== release.revision || receipt.taskset.contentHash !== release.contentHash) {
      throw new OpenPondTasksetPackageError(502, "package_receipt_mismatch", "Taskset publication receipt did not match the requested package and owner.");
    }
    if (request.selection !== undefined && receipt.selection !== request.selection) throw new OpenPondTasksetPackageError(502, "package_receipt_mismatch", "Taskset publication did not retain its selection mode.");
    if (request.selection === "attach" && receipt.projectEtag !== request.expectedProjectEtag) throw new OpenPondTasksetPackageError(502, "package_receipt_mismatch", "Attaching a historical Taskset changed the Model configuration.");
    if (request.modelConfiguration) {
      const expected = request.modelConfiguration;
      const project = receipt.project;
      const setup = HostedModelProjectTrainingSetupSchema.parse({ ...expected.trainingSetup, tasksetRef: learningRef(release),
        rewardBindingRef: request.package.modelResources ? learningRef(request.package.modelResources.rewardBinding) : null,
        tasksetRelease: null, recipe: null });
      if (!project || project.teamId !== this.#options.teamId || project.etag !== receipt.projectEtag
        || ![project.id, project.portableProjectId].includes(request.modelProjectId)
        || project.portableProjectId !== expected.portableProjectId || project.name !== expected.name || project.objective !== expected.objective
        || project.sourceRevision !== expected.sourceRevision || Date.parse(project.sourceUpdatedAt) !== Date.parse(expected.sourceUpdatedAt)
        || contentHash(project.defaultBaseModel) !== contentHash(expected.defaultBaseModel) || project.defaultDestinationId !== expected.defaultDestinationId
        || contentHash(project.trainingSetup) !== contentHash(setup)) {
        throw new OpenPondTasksetPackageError(502, "package_receipt_mismatch", "Taskset publication did not retain the requested Model configuration.");
      }
    }
    return receipt;
  }

  async get(modelProjectId: string, reference: z.infer<typeof TasksetCatalogReleaseRefSchema>, options: { signal?: AbortSignal; expectedPackageHash?: string } = {}): Promise<TasksetPackage> {
    const project = IdSchema.parse(modelProjectId);
    const ref = TasksetCatalogReleaseRefSchema.parse(reference);
    const expectedPackageHash = options.expectedPackageHash === undefined ? undefined : HashSchema.parse(options.expectedPackageHash);
    const response = TasksetPackageReadbackSchema.parse(await this.#request(`/${encodeURIComponent(project)}/${encodeURIComponent(ref.id)}/${ref.revision}/${ref.contentHash}`, "GET", undefined, options.signal));
    const taskset = response.package.taskset;
    if (response.teamId !== this.#options.teamId || response.modelProjectId !== project || taskset.id !== ref.id || taskset.revision !== ref.revision || taskset.contentHash !== ref.contentHash) throw new OpenPondTasksetPackageError(502, "package_readback_mismatch", "Taskset package did not match the requested release and owner.");
    if (expectedPackageHash !== undefined && response.package.contentHash !== expectedPackageHash) throw new OpenPondTasksetPackageError(502, "package_readback_mismatch", "Taskset package did not match the saved publication receipt.");
    return validateTasksetPackage(response.package);
  }

  async #request(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_TASKSET_PACKAGE_BYTES) throw new OpenPondTasksetPackageError(413, "package_too_large", "Taskset publication exceeds the 64 MiB envelope.");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/taskset-packages${path}`, {
      method, headers: { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId, Accept: "application/json", ...(serialized ? { "Content-Type": "application/json" } : {}) },
      body: serialized, signal, redirect: "error",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new OpenPondTasksetPackageError(response.status, "empty_response", "Taskset package response was empty.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_TASKSET_PACKAGE_BYTES) throw new OpenPondTasksetPackageError(413, "package_too_large", "Taskset response exceeds the 64 MiB envelope.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const payload: unknown = JSON.parse(text);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(payload);
      throw new OpenPondTasksetPackageError(response.status, error.success ? error.data.code : "package_request_failed", error.success ? error.data.message : `Taskset package request failed (${response.status}).`);
    }
    return payload;
  }
}
