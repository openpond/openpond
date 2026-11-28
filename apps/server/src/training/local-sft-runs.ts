import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LocalSftRunStateSchema, type LocalSftRun } from "@openpond/contracts/resource-setup";
import { loadLocalSftSessionApproval, localSftWorkerInputs } from "./local-sft-preflight.js";
import { LocalSftReviewError } from "./local-sft-review.js";
import { localSftRunSource } from "./local-sft-run-source.js";
import { localTrainingPythonCommand } from "./local-training-runtime.js";

type Request = Parameters<typeof loadLocalSftSessionApproval>[0];
type Run = NonNullable<LocalSftRun["run"]>;
type Receipt = Awaited<ReturnType<typeof loadLocalSftSessionApproval>>["approval"];
const uuid = z.uuid();
const processIdentity = z.object({ pid: z.number().int().positive(), boot: uuid, started: z.string().regex(/^\d+$/) }).strict();

function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

async function readJson(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")) as unknown; }
  catch (error) { if (missing(error)) return null; throw error; }
}

async function hasFile(file: string) {
  try { await stat(file); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}

async function workerAlive(identity: z.infer<typeof processIdentity>) {
  try {
    const [processStat, boot] = await Promise.all([
      readFile(`/proc/${identity.pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const fields = processStat.slice(processStat.lastIndexOf(") ") + 2).trim().split(/\s+/u);
    return boot.trim() === identity.boot && fields[0] !== "Z" && fields[19] === identity.started;
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function verifyAdapter(directory: string, state: Extract<Run["state"], { status: "completed" }>, approval: Receipt) {
  try {
    for (const [name, expected] of Object.entries(state.files)) {
      const file = path.join(directory, "adapter", name);
      if ((await stat(file)).size !== expected.bytes) return false;
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      if (digest.digest("hex") !== expected.sha256) return false;
    }
    const config = z.object({ peft_type: z.literal("LORA"), base_model_name_or_path: z.string(), revision: z.string() })
      .parse(await readJson(path.join(directory, "adapter", "adapter_config.json")));
    return config.base_model_name_or_path === approval.request.recipe.baseModel.id &&
      config.revision === approval.request.recipe.baseModel.revision;
  } catch { return false; }
}

async function readRun(directory: string, approval: Receipt, verifyCompleted = true): Promise<Run["state"]> {
  const saved = await readJson(path.join(directory, "status.json"));
  const parsed = LocalSftRunStateSchema.safeParse(saved);
  const state = parsed.success ? parsed.data : null;
  if (saved !== null && !state) return { status: "failed", reason: "worker_failed" };
  const device = state && "device" in state ? state.device : undefined;
  const tokens = state && "tokens" in state ? state.tokens : undefined;
  const limits = approval.request.recipe.resourceLimits;
  if (device && (device.usedBytes > device.budgetBytes || device.budgetBytes > Math.min(limits.memoryBytes, device.freeBytes)
    || device.freeBytes > device.capacityBytes) || tokens && tokens.rowCount !== approval.rowCount
    || state && "steps" in state && state.steps !== undefined &&
      (state.step === undefined || state.step > state.steps || state.steps > approval.request.recipe.optimizer.maxSteps)) {
    return { status: "failed", reason: "worker_failed" };
  }
  if (state?.status === "completed") {
    return state.step === state.steps && (!verifyCompleted || await verifyAdapter(directory, state, approval))
      ? state : { status: "failed", reason: "artifact_invalid" };
  }
  if (state?.status === "cancelled" || state?.status === "failed") return state;

  const cancelled = await hasFile(path.join(directory, "cancel"));
  const processFile = path.join(directory, "process.json");
  const created = (await stat(directory)).birthtimeMs;
  const age = Date.now() - created;
  const identity = processIdentity.safeParse(await readJson(processFile));
  const active = identity.success ? await workerAlive(identity.data) : age < 30_000;
  if (!active) {
    // The worker can publish its terminal state between the two reads.
    if (await hasFile(path.join(directory, "status.json")) && JSON.stringify(await readJson(path.join(directory, "status.json"))) !== JSON.stringify(saved)) {
      return readRun(directory, approval, verifyCompleted);
    }
    if (cancelled) return { status: "cancelled", reason: "cancelled" };
    return { status: "failed", reason: age >= limits.wallTimeMs ? "time_limit" : "worker_stopped" };
  }
  return cancelled ? { status: "cancelling" } : state ?? { status: "starting" };
}

async function latestRun(directory: string, approval: Receipt) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (missing(error)) return [];
    throw error;
  });
  const candidates = await Promise.all(entries.filter(entry => entry.isDirectory() && uuid.safeParse(entry.name).success)
    .map(async entry => ({ id: entry.name, time: (await stat(path.join(directory, entry.name))).birthtimeMs })));
  candidates.sort((first, second) => second.time - first.time || second.id.localeCompare(first.id));
  for (const candidate of candidates) {
    const state = await readRun(path.join(directory, candidate.id), approval, false);
    if (state.status === "starting" || state.status === "running" || state.status === "cancelling") return candidate.id;
  }
  return candidates[0]?.id;
}

async function launch(directory: string, storeDir: string, input: Awaited<ReturnType<typeof localSftWorkerInputs>>) {
  const command = localTrainingPythonCommand(storeDir, localSftRunSource);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      ...command.options, detached: true, stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.stdin.on("error", () => { /* The process state detects a worker that exits early. */ });
    child.once("spawn", () => {
      child.stdin.end(JSON.stringify({ ...input, runDirectory: directory }));
      child.unref();
      resolve();
    });
  });
}

export async function localSftRun(request: Request & { operation: "start" | "status" | "cancel"; runId?: string }): Promise<LocalSftRun> {
  const { operation, planHash, storeDir } = request;
  const record = await loadLocalSftSessionApproval(request);
  const root = path.join(storeDir, "training", "local-sft", "runs", planHash);
  const id = request.runId ?? await latestRun(root, record.approval);
  if (!id) return { planHash, run: null };
  const directory = path.join(root, id);
  if (operation === "start" && !await hasFile(directory)) {
    if (process.platform !== "linux") throw new LocalSftReviewError("Local SFT requires Linux.");
    const input = await localSftWorkerInputs(storeDir, record, request.signal);
    await mkdir(root, { recursive: true, mode: 0o700 });
    request.signal?.throwIfAborted();
    const reserved = await mkdir(directory, { mode: 0o700 }).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    });
    if (reserved) {
      try { await launch(directory, storeDir, input); }
      catch (error) {
        await writeFile(path.join(directory, "status.json"), JSON.stringify({
          status: "failed", reason: missing(error) ? "python_missing" : "worker_failed",
        }), { mode: 0o600 });
      }
    }
  }
  if (!await hasFile(directory)) return { planHash, run: null };
  const state = await readRun(directory, record.approval);
  if (operation === "cancel" && (state.status === "starting" || state.status === "running")) {
    await writeFile(path.join(directory, "cancel"), "", { mode: 0o600 });
    return { planHash, run: { id, state: await readRun(directory, record.approval) } };
  }
  return { planHash, run: { id, state } };
}
