import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelDownloadJobSchema, type ComputeSettings, type ModelDownloadJob } from "@openpond/contracts";
import { SMOLLM2_MODEL } from "./smollm2.js";

type ActiveDownload = { child: ChildProcessWithoutNullStreams; job: ModelDownloadJob };

export function createModelDownloadService(deps: { storeDir: string; projectDir: string; settings: () => Promise<ComputeSettings>; onComplete: () => Promise<void> }) {
  const statePath = path.join(deps.storeDir, "compute", "model-downloads.json");
  const active = new Map<string, ActiveDownload>();
  void reconcileInterrupted();

  async function list(): Promise<ModelDownloadJob[]> {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      return Array.isArray(parsed) ? parsed.map((item) => { const job = ModelDownloadJobSchema.parse(item); return job.downloadedBytes > job.expectedBytes ? { ...job, downloadedBytes: job.expectedBytes } : job; }) : [];
    } catch { return []; }
  }

  async function start(): Promise<ModelDownloadJob> {
    if (active.size) throw new Error("A model download is already running.");
    const settings = await deps.settings();
    if (!settings.modelStorePath) throw new Error("Choose a model storage folder in Settings > Compute before downloading.");
    const root = path.resolve(settings.modelStorePath);
    await mkdir(root, { recursive: true }).catch(() => { throw new Error("The configured model storage folder could not be created."); });
    await access(root, constants.W_OK).catch(() => { throw new Error("The configured model storage folder is not writable."); });
    const storage = await statfs(root);
    const freeBytes = Number(storage.bavail) * Number(storage.bsize);
    if (!Number.isSafeInteger(freeBytes) || freeBytes < Math.ceil(SMOLLM2_MODEL.expectedBytes * 1.2)) throw new Error("The configured model store does not have enough free space for SmolLM2 and download staging.");
    const destinationPath = path.join(root, "HuggingFaceTB", "SmolLM2-135M-Instruct", SMOLLM2_MODEL.revision);
    const previous = (await list()).find((job) => job.modelId === SMOLLM2_MODEL.id && job.revision === SMOLLM2_MODEL.revision && job.status === "succeeded");
    if (previous) return previous;
    await mkdir(destinationPath, { recursive: true });
    const now = new Date().toISOString();
    let job = ModelDownloadJobSchema.parse({ schemaVersion: "openpond.modelDownload.v1", id: `model_download_${randomUUID()}`, modelId: SMOLLM2_MODEL.id, revision: SMOLLM2_MODEL.revision, license: SMOLLM2_MODEL.license, destinationPath, expectedBytes: SMOLLM2_MODEL.expectedBytes, downloadedBytes: 0, status: "queued", error: null, startedAt: null, completedAt: null, createdAt: now, updatedAt: now });
    await save(job);
    const child = spawn("uv", ["run", "--project", deps.projectDir, "openpond-models", "download", "--model-id", SMOLLM2_MODEL.id, "--revision", SMOLLM2_MODEL.revision, "--destination", destinationPath, "--license", SMOLLM2_MODEL.license, "--expected-bytes", String(SMOLLM2_MODEL.expectedBytes), "--weight-sha256", SMOLLM2_MODEL.weightSha256, "--chat-template-hash", SMOLLM2_MODEL.chatTemplateHash, "--architecture", SMOLLM2_MODEL.architecture, "--parameter-count", String(SMOLLM2_MODEL.parameterCount)], { cwd: deps.projectDir, env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    job = await update(job, { status: "downloading", startedAt: now });
    active.set(job.id, { child, job });
    void consume(job, child);
    return job;
  }

  async function cancel(jobId: string): Promise<ModelDownloadJob> {
    const jobs = await list();
    const job = jobs.find((item) => item.id === jobId);
    if (!job) throw new Error("Model download was not found.");
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    const updated = await update(job, { status: "cancelling" });
    active.get(jobId)?.child.kill("SIGTERM");
    return updated;
  }

  async function consume(initial: ModelDownloadJob, child: ChildProcessWithoutNullStreams): Promise<void> {
    let stdout = "";
    let stderr = "";
    let writes = Promise.resolve();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) writes = writes.then(() => consumeEvent(initial.id, line));
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", () => resolve({ code: 1, signal: null })); });
    if (stdout.trim()) writes = writes.then(() => consumeEvent(initial.id, stdout));
    await writes;
    active.delete(initial.id);
    const latest = (await list()).find((item) => item.id === initial.id) ?? initial;
    if (latest.status === "succeeded") { await deps.onComplete(); return; }
    const cancelled = latest.status === "cancelling" || exit.code === 130 || exit.signal === "SIGTERM";
    await update(latest, { status: cancelled ? "cancelled" : "failed", completedAt: new Date().toISOString(), error: cancelled ? null : (latest.error ?? (stderr || `Model downloader exited with ${exit.code ?? exit.signal}.`)) });
  }

  async function consumeEvent(jobId: string, line: string): Promise<void> {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const job = (await list()).find((item) => item.id === jobId);
    if (!job) return;
    const downloadedBytes = typeof event.downloadedBytes === "number" && Number.isFinite(event.downloadedBytes) ? Math.min(job.expectedBytes, Math.max(job.downloadedBytes, Math.floor(event.downloadedBytes))) : Math.min(job.expectedBytes, job.downloadedBytes);
    if (event.type === "progress") await update(job, { downloadedBytes });
    else if (event.type === "verifying") await update(job, { status: "verifying", downloadedBytes });
    else if (event.type === "complete") await update(job, { status: "succeeded", downloadedBytes, completedAt: new Date().toISOString(), error: null });
    else if (event.type === "cancel") await update(job, { status: "cancelled", downloadedBytes, completedAt: new Date().toISOString(), error: null });
    else if (event.type === "failure") await update(job, { status: "failed", downloadedBytes, completedAt: new Date().toISOString(), error: typeof event.message === "string" ? event.message : "Model download failed." });
  }

  async function update(job: ModelDownloadJob, patch: Partial<ModelDownloadJob>): Promise<ModelDownloadJob> {
    const updated = ModelDownloadJobSchema.parse({ ...job, ...patch, updatedAt: new Date().toISOString() });
    await save(updated);
    const running = active.get(job.id);
    if (running) running.job = updated;
    return updated;
  }

  async function save(job: ModelDownloadJob): Promise<void> {
    const jobs = await list();
    const index = jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) jobs[index] = job; else jobs.push(job);
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
  }

  async function close(): Promise<void> {
    for (const running of active.values()) running.child.kill("SIGTERM");
    await Promise.all([...active.values()].map(({ child }) => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once("exit", () => resolve()); setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000).unref?.(); })));
  }

  async function reconcileInterrupted(): Promise<void> {
    for (const job of await list()) {
      if (!["queued", "downloading", "verifying", "cancelling"].includes(job.status)) continue;
      await update(job, { status: job.status === "cancelling" ? "cancelled" : "failed", completedAt: new Date().toISOString(), error: job.status === "cancelling" ? null : "OpenPond restarted during this download. Start it again to resume from the verified partial files." });
    }
  }

  return { list, start, cancel, close };
}
