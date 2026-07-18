import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GradeResultSchema,
  ModelArtifactLineageSchema,
  TaskAttemptArtifactSchema,
  TaskAttemptResultSchema,
  TrainingArtifactSchema,
  TrainingDestinationCapabilitiesSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
  type TrainingApproval,
  type TrainingArtifact,
  type TrainingCompatibilityReport,
  type TrainingDestinationCapabilities,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { contentHash, gradeAttempt, sha256 } from "@openpond/taskset-sdk";
import { validateTrainingCompatibility, type TrainingDestination } from "@openpond/training-sdk";
import { loadOpenPondProfileState } from "@openpond/cloud";
import type { SqliteStore } from "../store/store.js";
import { runSandboxedVerifier } from "./sandboxed-verifier.js";

type ActiveWorker = { child: ChildProcessWithoutNullStreams; cancelFile: string; timeout: ReturnType<typeof setTimeout> };

export class LocalCpuTrainingDestination implements TrainingDestination {
  readonly id = "local_cpu_fixture" as const;
  private readonly active = new Map<string, ActiveWorker>();
  private readonly consumers = new Map<string, Promise<void>>();

  constructor(private readonly deps: { store: SqliteStore; storeDir: string; projectDir: string; loadProfileState?: typeof loadOpenPondProfileState; resolveModelPath?: (modelId: string, revision: string) => Promise<string | null>; modelArtifactStore?: () => Promise<string | null> }) {}

  async capabilities(): Promise<TrainingDestinationCapabilities> {
    let available = true;
    let unavailableReason: string | null = null;
    try { await access(path.join(this.deps.projectDir, "pyproject.toml")); } catch { available = false; unavailableReason = "The optional python/openpond-training worker is not installed with this source checkout."; }
    return TrainingDestinationCapabilitiesSchema.parse({ schemaVersion: "openpond.trainingDestinationCapabilities.v1", destinationId: this.id, available, methods: ["sft"], parameterizations: ["lora"], modelAllowlist: ["openpond/tiny-cpu-gpt2-fixture", "HuggingFaceTB/SmolLM2-135M-Instruct"], maxDatasetBytes: 10_000_000, environmentPlacements: ["none"], nonProduction: true, unavailableReason, checkedAt: new Date().toISOString() });
  }

  async validate(plan: TrainingPlan): Promise<TrainingCompatibilityReport> {
    const taskset = await this.deps.store.getTaskset(plan.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    return validateTrainingCompatibility({ taskset, plan, capabilities: await this.capabilities() });
  }

  async quote(): Promise<{ estimatedCostUsd: number | null; assumptions: string[] }> {
    return { estimatedCostUsd: 0, assumptions: ["Developer correctness fixture on this machine's CPU.", "Artifact quality is non-production and cannot be promoted."] };
  }

  async launch(plan: TrainingPlan, approval: TrainingApproval): Promise<TrainingJob> {
    if (this.active.size > 0) throw new Error("The local CPU fixture runs one job at a time.");
    if (!plan.compatibility.compatible) throw new Error("Incompatible Training Plan cannot launch.");
    if (approval.planId !== plan.id || approval.destinationId !== this.id) throw new Error("Training approval does not match local CPU plan.");
    const bundle = await this.deps.store.findTrainingBundleByPlanAndHash(plan.id, approval.bundleHash);
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const taskset = await this.deps.store.getTaskset(plan.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    const timestamp = new Date().toISOString();
    const jobId = `training_job_${randomUUID()}`;
    const outputDirectory = path.join(this.deps.storeDir, "training", "jobs", jobId);
    const bundleDirectory = path.join(this.deps.storeDir, "training", "bundles", plan.id);
    const cancelFile = path.join(outputDirectory, "cancel.requested");
    const tasksetPath = await this.tasksetPath(taskset.id);
    await mkdir(outputDirectory, { recursive: true });
    const modelPath = await this.resolveModelPath(plan);
    const workerArgs = ["run", "--project", this.deps.projectDir, "openpond-training", "run", "--bundle", bundleDirectory, "--output", outputDirectory, "--job-id", jobId, "--cancel-file", cancelFile, "--taskset", tasksetPath];
    if (modelPath) workerArgs.push("--model-path", modelPath);
    const child = spawn("uv", workerArgs, {
      cwd: this.deps.projectDir,
      env: { ...process.env, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: jobId, planId: plan.id, bundleHash: bundle.contentHash, approvalId: approval.id, destinationId: this.id, status: "starting", nonProduction: true, workerPid: child.pid ?? null, startedAt: timestamp, completedAt: null, error: null, createdAt: timestamp, updatedAt: timestamp, metadata: { outputDirectory, workerProject: this.deps.projectDir, untested: ["CUDA", "SSH", "RunPod", "GRPO", "useful model quality", "production performance"] } });
    await this.deps.store.saveTrainingJob(job);
    const timeout = setTimeout(() => child.kill("SIGKILL"), plan.recipe.method === "sft" ? plan.recipe.resourceLimits.wallTimeMs + 5_000 : 125_000);
    timeout.unref?.();
    this.active.set(jobId, { child, cancelFile, timeout });
    this.trackConsumer(job, child, outputDirectory);
    return job;
  }

  async status(jobId: string): Promise<TrainingJob> { const job = await this.deps.store.getTrainingJob(jobId); if (!job) throw new Error("Training job not found."); return job; }

  async cancel(jobId: string): Promise<TrainingJob> {
    const job = await this.status(jobId);
    if (["cancelled", "succeeded", "failed"].includes(job.status)) return job;
    const worker = this.active.get(jobId);
    const timestamp = new Date().toISOString();
    await writeFile(worker?.cancelFile ?? path.join(this.deps.storeDir, "training", "jobs", jobId, "cancel.requested"), timestamp + "\n", "utf8");
    worker?.child.kill("SIGTERM");
    const updated = TrainingJobSchema.parse({ ...job, status: "cancelling", updatedAt: timestamp });
    await this.deps.store.saveTrainingJob(updated);
    return updated;
  }

  async collect(jobId: string): Promise<TrainingArtifact[]> { return this.deps.store.listTrainingArtifacts(jobId); }

  async importExternal(input: { planId: string; bundleId: string; artifactDirectory: string }): Promise<TrainingJob> {
    if (this.active.size > 0) throw new Error("The local CPU fixture runs one job at a time.");
    const plan = await this.deps.store.getTrainingPlan(input.planId);
    const bundle = await this.deps.store.getTrainingBundle(input.bundleId);
    if (!plan || !bundle || bundle.planId !== plan.id) throw new Error("Training Plan and Bundle do not match this import.");
    if (plan.recipe.schemaVersion !== "openpond.sftRecipe.v1") throw new Error("Only a LoRA SFT adapter can be imported by the local fixture.");
    const sourceDirectory = path.resolve(input.artifactDirectory);
    await assertPortableArtifactTree(sourceDirectory);
    const sourceManifest = JSON.parse(await readFile(path.join(sourceDirectory, "artifact-manifest.json"), "utf8")) as { schemaVersion?: string };
    if (sourceManifest.schemaVersion !== "openpond.localTrainingArtifactManifest.v1") throw new Error("Manual import requires an OpenPond portable artifact manifest.");
    const timestamp = new Date().toISOString();
    const jobId = `training_job_${randomUUID()}`;
    const outputDirectory = path.join(this.deps.storeDir, "training", "jobs", jobId);
    if (sourceDirectory === outputDirectory || sourceDirectory.startsWith(`${outputDirectory}${path.sep}`)) throw new Error("Import source cannot be inside its destination.");
    await mkdir(path.dirname(outputDirectory), { recursive: true });
    await rm(outputDirectory, { recursive: true, force: true });
    await cp(sourceDirectory, outputDirectory, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await unlink(path.join(outputDirectory, "events.jsonl")).catch(() => undefined);
    const tasksetPath = await this.tasksetPath(plan.tasksetId);
    const bundleDirectory = path.join(this.deps.storeDir, "training", "bundles", plan.id);
    const cancelFile = path.join(outputDirectory, "cancel.requested");
    const modelPath = await this.resolveModelPath(plan);
    const workerArgs = ["run", "--project", this.deps.projectDir, "openpond-training", "evaluate", "--bundle", bundleDirectory, "--output", outputDirectory, "--job-id", jobId, "--cancel-file", cancelFile, "--taskset", tasksetPath];
    if (modelPath) workerArgs.push("--model-path", modelPath);
    const child = spawn("uv", workerArgs, { cwd: this.deps.projectDir, env: { ...process.env, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    const job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: jobId, planId: plan.id, bundleHash: bundle.contentHash, approvalId: "manual_import_approval", destinationId: this.id, status: "starting", nonProduction: true, workerPid: child.pid ?? null, startedAt: timestamp, completedAt: null, error: null, createdAt: timestamp, updatedAt: timestamp, metadata: { outputDirectory, workerProject: this.deps.projectDir, manualImport: true, originalPlanDestinationId: plan.destinationId, sourceDirectory, untested: ["provider integration", "CUDA", "SSH", "RunPod", "GRPO", "useful model quality", "production performance"] } });
    await this.deps.store.saveTrainingJob(job);
    const timeout = setTimeout(() => child.kill("SIGKILL"), plan.recipe.method === "sft" ? plan.recipe.resourceLimits.wallTimeMs + 5_000 : 125_000);
    timeout.unref?.();
    this.active.set(job.id, { child, cancelFile, timeout });
    this.trackConsumer(job, child, outputDirectory);
    return job;
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.keys()].map((jobId) => this.cancel(jobId).catch(() => undefined)));
    await Promise.all([...this.active.values()].map(({ child, timeout }) => new Promise<void>((resolve) => {
      clearTimeout(timeout);
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const hardKillTimeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(hardKillTimeout); resolve(); });
    })));
    await Promise.allSettled([...this.consumers.values()]);
  }

  async reconcile(): Promise<void> {
    for (const job of await this.deps.store.listTrainingJobs()) {
      if (job.destinationId !== this.id || !["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status)) continue;
      if (job.workerPid && processIsAlive(job.workerPid)) { try { process.kill(job.workerPid, "SIGTERM"); } catch { /* already gone */ } }
      const timestamp = new Date().toISOString();
      await this.deps.store.saveTrainingJob({ ...job, status: job.status === "cancelling" ? "cancelled" : "failed", completedAt: timestamp, updatedAt: timestamp, error: job.status === "cancelling" ? null : "OpenPond restarted during the local CPU fixture; the orphan-safe reconciler terminated the old worker. Relaunch the approved plan." });
    }
  }

  private trackConsumer(job: TrainingJob, child: ChildProcessWithoutNullStreams, outputDirectory: string): void {
    const completion = this.consume(job, child, outputDirectory)
      .catch(async (error) => {
        const latest = await this.deps.store.getTrainingJob(job.id) ?? job;
        const timestamp = new Date().toISOString();
        await this.deps.store.saveTrainingJob({
          ...latest,
          status: "failed",
          completedAt: timestamp,
          updatedAt: timestamp,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.consumers.delete(job.id));
    this.consumers.set(job.id, completion);
  }

  private async consume(initialJob: TrainingJob, child: ChildProcessWithoutNullStreams, outputDirectory: string): Promise<void> {
    let stderr = "";
    let buffer = "";
    let eventWrites = Promise.resolve();
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) eventWrites = eventWrites.then(() => this.persistWorkerEvent(line));
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    if (buffer.trim()) eventWrites = eventWrites.then(() => this.persistWorkerEvent(buffer));
    await eventWrites;
    const active = this.active.get(initialJob.id);
    if (active) clearTimeout(active.timeout);
    this.active.delete(initialJob.id);
    const timestamp = new Date().toISOString();
    const latest = await this.deps.store.getTrainingJob(initialJob.id) ?? initialJob;
    if (exit.code !== 0) {
      const cancelled = latest.status === "cancelling" || exit.code === 130 || exit.signal === "SIGTERM";
      await this.deps.store.saveTrainingJob({ ...latest, status: cancelled ? "cancelled" : "failed", completedAt: timestamp, updatedAt: timestamp, error: cancelled ? null : stderr || `Worker exited with ${exit.code ?? exit.signal}.` });
      return;
    }
    const artifacts = await this.importArtifacts(initialJob, outputDirectory);
    const evaluation = artifacts.find((artifact) => artifact.kind === "evaluation") ?? null;
    const adapter = artifacts.find((artifact) => artifact.kind === "adapter");
    if (!adapter) throw new Error("Worker completed without a portable adapter artifact.");
    const taskset = await this.deps.store.getTaskset((await this.deps.store.getTrainingPlan(initialJob.planId))?.tasksetId ?? "");
    const plan = await this.deps.store.getTrainingPlan(initialJob.planId);
    if (!taskset || !plan) throw new Error("Training lineage source was not found.");
    const mirroredArtifactDirectory = await this.mirrorPortableArtifact(taskset.id, initialJob.id, outputDirectory);
    await this.deps.store.saveModelArtifactLineage(ModelArtifactLineageSchema.parse({ schemaVersion: "openpond.modelArtifactLineage.v1", id: `lineage_${adapter.id}`, modelId: plan.modelId, artifactId: adapter.id, jobId: initialJob.id, tasksetId: taskset.id, tasksetHash: taskset.contentHash, graderHash: contentHash(taskset.graders), planHash: plan.contentHash, bundleHash: initialJob.bundleHash, recipeHash: contentHash(plan.recipe), workerVersion: "0.0.1", trainerVersion: "trl-0.26.2", importedAt: timestamp, frozenEvaluationArtifactId: evaluation?.id ?? null, promotable: false }));
    await this.deps.store.saveTrainingJob({ ...latest, status: "succeeded", completedAt: timestamp, updatedAt: timestamp, error: null, metadata: { ...latest.metadata, artifactCount: artifacts.length, reloadVerified: true, frozenEvaluationExecuted: Boolean(evaluation), mirroredArtifactDirectory } });
  }

  private async persistWorkerEvent(line: string): Promise<void> {
    try {
      const event = TrainingJobEventSchema.parse(JSON.parse(line));
      await this.deps.store.saveTrainingJobEvent(event);
      const job = await this.deps.store.getTrainingJob(event.jobId);
      if (job && event.type === "start" && job.status === "starting") await this.deps.store.saveTrainingJob({ ...job, status: "running", updatedAt: event.timestamp });
    } catch { /* Third-party library output is kept in stderr/log artifacts, not normalized as an event. */ }
  }

  private async importArtifacts(job: TrainingJob, outputDirectory: string): Promise<TrainingArtifact[]> {
    const manifestPath = path.join(outputDirectory, "artifact-manifest.json");
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { baseModel: { id: string; revision: string }; tokenizerRevision: string; tokenizerHash: string; chatTemplateHash: string; nonProduction: boolean; artifacts: Array<{ path: string; sha256: string; sizeBytes: number }> };
    if (!manifest.nonProduction) throw new Error("Local fixture artifact must be marked non-production.");
    if (!/^[a-f0-9]{64}$/.test(manifest.tokenizerHash)) throw new Error("Local fixture artifact has no recorded tokenizer hash.");
    const imported: TrainingArtifact[] = [];
    for (const item of manifest.artifacts) {
      const target = path.resolve(outputDirectory, item.path);
      if (!target.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) throw new Error("Artifact path escaped the job directory.");
      const bytes = await readFile(target);
      if (sha256(bytes) !== item.sha256 || bytes.byteLength !== item.sizeBytes) throw new Error(`Artifact verification failed for ${item.path}.`);
      const kind = item.path.endsWith("adapter_model.safetensors") ? "adapter" : item.path === "metrics.json" || item.path === "step-metrics.jsonl" ? "metrics" : item.path === "frozen-eval-predictions.jsonl" ? "evaluation" : item.path === "events.jsonl" ? "log" : "checkpoint";
      const artifact = TrainingArtifactSchema.parse({ schemaVersion: "openpond.trainingArtifact.v1", id: `artifact_${contentHash([job.id, item.path, item.sha256]).slice(0, 24)}`, jobId: job.id, kind, path: target, sha256: item.sha256, sizeBytes: item.sizeBytes, baseModelId: manifest.baseModel.id, baseModelRevision: manifest.baseModel.revision, tokenizerRevision: manifest.tokenizerRevision, chatTemplateHash: manifest.chatTemplateHash, nonProduction: true, createdAt: new Date().toISOString(), metadata: { relativePath: item.path, verified: true, tokenizerHash: manifest.tokenizerHash } });
      await this.deps.store.saveTrainingArtifact(artifact);
      imported.push(artifact);
    }
    const manifestArtifact = TrainingArtifactSchema.parse({ schemaVersion: "openpond.trainingArtifact.v1", id: `artifact_${contentHash([job.id, "artifact-manifest", sha256(manifestBytes)]).slice(0, 24)}`, jobId: job.id, kind: "manifest", path: manifestPath, sha256: sha256(manifestBytes), sizeBytes: manifestBytes.byteLength, baseModelId: manifest.baseModel.id, baseModelRevision: manifest.baseModel.revision, tokenizerRevision: manifest.tokenizerRevision, chatTemplateHash: manifest.chatTemplateHash, nonProduction: true, createdAt: new Date().toISOString(), metadata: { verified: true } });
    await this.deps.store.saveTrainingArtifact(manifestArtifact);
    imported.push(manifestArtifact);
    try {
      const logPath = path.join(outputDirectory, "events.jsonl");
      const logBytes = await readFile(logPath);
      const logArtifact = TrainingArtifactSchema.parse({ schemaVersion: "openpond.trainingArtifact.v1", id: `artifact_${contentHash([job.id, "events", sha256(logBytes)]).slice(0, 24)}`, jobId: job.id, kind: "log", path: logPath, sha256: sha256(logBytes), sizeBytes: logBytes.byteLength, baseModelId: manifest.baseModel.id, baseModelRevision: manifest.baseModel.revision, tokenizerRevision: manifest.tokenizerRevision, chatTemplateHash: manifest.chatTemplateHash, nonProduction: true, createdAt: new Date().toISOString(), metadata: { verified: true } });
      await this.deps.store.saveTrainingArtifact(logArtifact);
      imported.push(logArtifact);
    } catch { /* A missing local event log does not invalidate verified model artifacts. */ }
    await this.importFrozenEvaluation(job, outputDirectory, "base-frozen-eval-predictions.jsonl", "base");
    await this.importFrozenEvaluation(job, outputDirectory, "frozen-eval-predictions.jsonl", "trained");
    return imported;
  }

  private async importFrozenEvaluation(job: TrainingJob, outputDirectory: string, filename: string, evaluationStage: "base" | "trained"): Promise<void> {
    const plan = await this.deps.store.getTrainingPlan(job.planId);
    const taskset = plan ? await this.deps.store.getTaskset(plan.tasksetId) : null;
    if (!plan || !taskset) return;
    const tasksetRoot = path.dirname(await this.tasksetPath(taskset.id));
    let content: string;
    try { content = await readFile(path.join(outputDirectory, filename), "utf8"); } catch { return; }
    for (const [index, line] of content.split("\n").filter(Boolean).entries()) {
      const prediction = JSON.parse(line) as { taskId: string; seed: number; output: Record<string, unknown> };
      const task = taskset.tasks.find((item) => item.id === prediction.taskId);
      if (!task) continue;
      const timestamp = new Date().toISOString();
      const attemptId = `attempt_${contentHash([job.id, evaluationStage, prediction.taskId, index]).slice(0, 24)}`;
      const rawDirectory = path.join(outputDirectory, "frozen-eval-attempts", evaluationStage);
      const rawPath = path.join(rawDirectory, `${attemptId}.json`);
      const rawBytes = Buffer.from(`${JSON.stringify(prediction, null, 2)}\n`, "utf8");
      await mkdir(rawDirectory, { recursive: true });
      await writeFile(rawPath, rawBytes, { mode: 0o600 });
      const rawArtifact = TaskAttemptArtifactSchema.parse({ schemaVersion: "openpond.taskAttemptArtifact.v1", id: `attempt_artifact_${contentHash([attemptId, sha256(rawBytes)]).slice(0, 24)}`, tasksetId: taskset.id, taskId: task.id, attemptId, kind: "raw_model_response", path: rawPath, sha256: sha256(rawBytes), sizeBytes: rawBytes.byteLength, createdAt: timestamp, metadata: { jobId: job.id, frozen: true, localOnly: true, evaluationStage } });
      await this.deps.store.saveTaskAttemptArtifact(rawArtifact);
      const baseModelId = plan.recipe.method === "sft" ? plan.recipe.baseModel.id : "local-model";
      const modelId = evaluationStage === "trained" ? `${baseModelId}+lora` : baseModelId;
      const attempt = TaskAttemptResultSchema.parse({ schemaVersion: "openpond.taskAttempt.v1", id: attemptId, tasksetId: taskset.id, taskId: task.id, split: "frozen_eval", attempt: 0, seed: prediction.seed, modelRef: { providerId: "custom-openai-compatible", modelId }, startedAt: timestamp, completedAt: timestamp, output: prediction.output, runtimeEventRefs: [], artifactRefs: [rawArtifact.id], privilegedOutcomeRef: task.privilegedContextRef, infrastructureError: null, costUsd: 0, latencyMs: 0, userInterventions: 0, metadata: { jobId: job.id, frozen: true, localArtifact: true, evaluationStage } });
      const grade = GradeResultSchema.parse(await gradeAttempt({
        task,
        attempt,
        graders: taskset.graders,
        customVerifier: ({ grader, task: gradedTask, attempt: gradedAttempt }) => runSandboxedVerifier({
          grader,
          task: gradedTask,
          attempt: gradedAttempt,
          allowedRoot: tasksetRoot,
        }),
      }));
      await this.deps.store.saveTaskAttempt(attempt);
      await this.deps.store.saveGradeResult(grade);
    }
  }

  private async tasksetPath(tasksetId: string): Promise<string> {
    const taskset = await this.deps.store.getTaskset(tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    const candidates = [
      path.join(this.deps.storeDir, "training", "tasksets", taskset.id, "taskset.json"),
      ...taskset.sourceRefs.map(() => ""),
    ];
    for (const candidate of candidates) if (candidate) { try { await access(candidate); return candidate; } catch { /* continue */ } }
    throw new Error("Materialized Taskset source file was not found.");
  }

  private async resolveModelPath(plan: TrainingPlan): Promise<string | null> {
    if (plan.recipe.method !== "sft" || plan.recipe.baseModel.id === "openpond/tiny-cpu-gpt2-fixture") return null;
    const resolved = await this.deps.resolveModelPath?.(plan.recipe.baseModel.id, plan.recipe.baseModel.revision);
    if (!resolved) throw new Error(`Verified local model ${plan.recipe.baseModel.id}@${plan.recipe.baseModel.revision} was not found. Download it in Settings > Compute.`);
    return resolved;
  }

  private async mirrorPortableArtifact(tasksetId: string, jobId: string, outputDirectory: string): Promise<string | null> {
    const root = await this.deps.modelArtifactStore?.();
    if (!root) return null;
    const destination = path.join(path.resolve(root), "OpenPond", "adapters", tasksetId, jobId);
    if (destination === outputDirectory || destination.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) throw new Error("Model artifact mirror cannot be inside the worker output directory.");
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await copyTreePortable(outputDirectory, destination);
    await assertPortableArtifactTree(destination);
    return destination;
  }
}

function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function assertPortableArtifactTree(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Artifact import source must be a real directory.");
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Artifact import rejects symbolic links: ${entry.name}.`);
    if (stat.isDirectory()) await assertPortableArtifactTree(target);
  }
}

async function copyTreePortable(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`Portable artifact mirror rejects symbolic links: ${source}.`);
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyTreePortable(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`Portable artifact mirror rejects unsupported filesystem entries: ${source}.`);
  await copyFile(source, destination);
}
