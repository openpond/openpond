import { Buffer } from "node:buffer";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

type VoiceLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
};

export type VoiceTranscriptionStatus = {
  available: boolean;
  binaryPath: string | null;
  modelName: string;
  modelPath: string;
  modelReady: boolean;
  canDownloadModel: boolean;
  installHint: string | null;
};

export type VoiceTranscriptionResponse = {
  text: string;
  binaryPath: string;
  modelName: string;
  modelPath: string;
  durationMs: number;
};

type VoiceTranscriptionRequest = {
  audioBase64: string;
  mimeType: string;
  durationMs?: number;
  language?: string;
};

const DEFAULT_MODEL_NAME = "base.en";
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const MODEL_MIN_BYTES = 10 * 1024 * 1024;
const MODEL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PROCESS_OUTPUT_MAX_CHARS = 64 * 1024;
const WHISPER_CPP_VERSION = "v1.9.2";
const WHISPER_CPP_RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}`;
const BINARY_DIR_NAME = "voice-binaries";
const BINARY_MIN_BYTES = 500_000;
const BINARY_MAX_BYTES = 100_000_000;

export function createVoiceTranscriptionService(input: {
  storeDir: string;
  logger: VoiceLogger;
}): {
  status: () => Promise<VoiceTranscriptionStatus>;
  transcribe: (payload: unknown) => Promise<VoiceTranscriptionResponse>;
  close: () => Promise<void>;
} {
  const modelName = normalizedModelName(process.env.OPENPOND_WHISPER_MODEL_NAME);
  const modelPath =
    process.env.OPENPOND_WHISPER_MODEL?.trim() ||
    path.join(input.storeDir, "voice-models", `ggml-${modelName}.bin`);
  let modelDownload: Promise<string> | null = null;
  let binaryDownload: Promise<string> | null = null;
  const closeController = new AbortController();
  const activeProcesses = new Set<ChildProcess>();
  const activeTranscriptions = new Set<Promise<VoiceTranscriptionResponse>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  async function status(): Promise<VoiceTranscriptionStatus> {
    const binaryPath = await ensureBinary();
    const modelReady = await fileExists(modelPath);
    return {
      available: Boolean(binaryPath && (modelReady || canDownloadDefaultModel())),
      binaryPath,
      modelName,
      modelPath,
      modelReady,
      canDownloadModel: canDownloadDefaultModel(),
      installHint: binaryPath ? null : whisperInstallHint(),
    };
  }

  async function ensureBinary(): Promise<string | null> {
    const resolved = await resolveWhisperBinary();
    if (resolved) return resolved;

    const assetInfo = getPlatformAssetInfo();
    if (!assetInfo) return null;

    const binaryDir = path.join(input.storeDir, BINARY_DIR_NAME);
    const binaryPath = path.join(binaryDir, "whisper-cli");

    if (await fileExists(binaryPath)) {
      const isExec = await executableExists(binaryPath);
      if (isExec) return binaryPath;
    }

    if (!binaryDownload) {
      binaryDownload = downloadAndExtractWhisperBinary(
        binaryDir,
        binaryPath,
        assetInfo,
        input.logger,
        closeController.signal,
      ).finally(() => {
        binaryDownload = null;
      });
    }
    return binaryDownload;
  }

  async function ensureModel(): Promise<string> {
    if (await fileExists(modelPath)) return modelPath;
    if (process.env.OPENPOND_WHISPER_MODEL?.trim()) {
      throw new Error(`Whisper model not found at ${modelPath}.`);
    }
    if (!canDownloadDefaultModel()) {
      throw new Error("Automatic Whisper model download is disabled for this model.");
    }
    if (!modelDownload) {
      modelDownload = downloadDefaultModel(
        modelPath,
        modelName,
        input.logger,
        closeController.signal,
      ).finally(() => {
        modelDownload = null;
      });
    }
    return modelDownload;
  }

  function transcribe(payload: unknown): Promise<VoiceTranscriptionResponse> {
    if (closing) return Promise.reject(new Error("Voice transcription service is closed."));
    const operation = runTranscription(payload);
    activeTranscriptions.add(operation);
    void operation.finally(() => activeTranscriptions.delete(operation)).catch(() => undefined);
    return operation;
  }

  async function runTranscription(payload: unknown): Promise<VoiceTranscriptionResponse> {
    const request = parseVoiceTranscriptionRequest(payload);
    const binaryPath = await ensureBinary();
    if (!binaryPath) throw new Error(whisperInstallHint());

    const audio = Buffer.from(request.audioBase64, "base64");
    if (audio.byteLength === 0) throw new Error("No voice audio was recorded.");
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      throw new Error("Voice recording is too large. Keep dictation under two minutes.");
    }

    const selectedModelPath = await ensureModel();
    const workDir = path.join(input.storeDir, "tmp", "voice");
    await fs.mkdir(workDir, { recursive: true });
    const id = randomUUID();
    const audioPath = path.join(workDir, `${id}.wav`);
    const outputPrefix = path.join(workDir, id);
    const outputTextPath = `${outputPrefix}.txt`;

    await fs.writeFile(audioPath, audio, { mode: 0o600 });
    try {
      await runWhisper({
        audioPath,
        binaryPath,
        language: request.language ?? "en",
        modelPath: selectedModelPath,
        outputPrefix,
        signal: closeController.signal,
        activeProcesses,
      });
      const outputFileText = await fs.readFile(outputTextPath, "utf8").catch(() => "");
      const text = cleanWhisperText(outputFileText);
      if (!text) throw new Error("No speech was detected.");
      return {
        text,
        binaryPath,
        modelName,
        modelPath: selectedModelPath,
        durationMs: request.durationMs ?? 0,
      };
    } finally {
      await Promise.all([
        fs.rm(audioPath, { force: true }),
        fs.rm(outputTextPath, { force: true }),
      ]);
    }
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closeController.abort();
    for (const child of activeProcesses) stopVoiceProcess(child);
    closePromise = Promise.allSettled([...activeTranscriptions, ...(modelDownload ? [modelDownload] : []), ...(binaryDownload ? [binaryDownload] : [])])
      .then(() => {
        if (activeProcesses.size > 0) {
          throw new Error(`Voice transcription leaked ${activeProcesses.size} process(es).`);
        }
      });
    return closePromise;
  }

  return { close, status, transcribe };
}

function parseVoiceTranscriptionRequest(payload: unknown): VoiceTranscriptionRequest {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const audioBase64 = typeof record.audioBase64 === "string" ? record.audioBase64.trim() : "";
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
  if (!audioBase64) throw new Error("Voice transcription requires audio.");
  if (mimeType && mimeType !== "audio/wav" && mimeType !== "audio/wave") {
    throw new Error(`Unsupported voice audio format: ${mimeType}`);
  }
  return {
    audioBase64,
    mimeType: mimeType || "audio/wav",
    durationMs: typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
      ? Math.max(0, Math.round(record.durationMs))
      : undefined,
    language: typeof record.language === "string" && record.language.trim()
      ? record.language.trim()
      : undefined,
  };
}

async function runWhisper(input: {
  binaryPath: string;
  modelPath: string;
  audioPath: string;
  outputPrefix: string;
  language: string;
  signal: AbortSignal;
  activeProcesses: Set<ChildProcess>;
}): Promise<void> {
  const threadCount = Math.max(1, Math.min(8, os.cpus().length - 1 || 1));
  const args = [
    "-m",
    input.modelPath,
    "-f",
    input.audioPath,
    "-l",
    input.language,
    "-t",
    String(threadCount),
    "-nt",
    "-otxt",
    "-of",
    input.outputPrefix,
  ];
  await new Promise<void>((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new Error("Voice transcription service is closed."));
      return;
    }
    const child = spawn(input.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure whisper-cli can find shared libraries bundled alongside it
        LD_LIBRARY_PATH: [path.dirname(input.binaryPath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      },
    });
    input.activeProcesses.add(child);
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopVoiceProcess(child);
    }, TRANSCRIPTION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedProcessOutput(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedProcessOutput(stderr, chunk.toString("utf8"));
    });
    const onAbort = () => stopVoiceProcess(child);
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      input.activeProcesses.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      input.activeProcesses.delete(child);
      if (input.signal.aborted) {
        reject(new Error("Voice transcription service is closed."));
        return;
      }
      if (timedOut) {
        reject(new Error("Voice transcription timed out."));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = cleanProcessOutput(stderr || stdout);
      reject(new Error(`whisper.cpp transcription failed${detail ? `: ${detail}` : ""}`));
    });
  });
}

function stopVoiceProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_500);
  timer.unref();
}

function boundedProcessOutput(current: string, delta: string): string {
  const next = `${current}${delta}`;
  return next.length <= PROCESS_OUTPUT_MAX_CHARS
    ? next
    : next.slice(next.length - PROCESS_OUTPUT_MAX_CHARS);
}

function cleanWhisperText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, "").trim())
    .filter((line) => Boolean(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanProcessOutput(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("whisper_") && !line.startsWith("system_info:"))
    .slice(-4)
    .join(" ");
}

function normalizedModelName(value?: string): string {
  const modelName = value?.trim() || DEFAULT_MODEL_NAME;
  if (!/^[A-Za-z0-9_.-]+$/.test(modelName)) return DEFAULT_MODEL_NAME;
  return modelName;
}

function canDownloadDefaultModel(): boolean {
  return !process.env.OPENPOND_WHISPER_MODEL?.trim();
}

async function downloadDefaultModel(
  targetPath: string,
  modelName: string,
  logger: VoiceLogger,
  signal: AbortSignal,
): Promise<string> {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  logger.info("downloading whisper model", { modelName, targetPath });
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download Whisper model: ${response.status} ${response.statusText}`.trim());
  }
  const sizeBytes = await streamVoiceModelResponseToFile({
    response,
    targetPath: tempPath,
    signal,
    minBytes: MODEL_MIN_BYTES,
    maxBytes: MODEL_MAX_BYTES,
  });
  await fs.rename(tempPath, targetPath);
  await fs.chmod(targetPath, 0o600).catch(() => undefined);
  logger.info("whisper model downloaded", { modelName, targetPath, sizeBytes });
  return targetPath;
}

export async function streamVoiceModelResponseToFile(input: {
  response: Response;
  targetPath: string;
  signal: AbortSignal;
  minBytes: number;
  maxBytes: number;
}): Promise<number> {
  const declaredBytes = Number(input.response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > input.maxBytes) {
    throw new Error("Whisper model download exceeds the configured byte limit.");
  }
  const reader = input.response.body?.getReader();
  if (!reader) throw new Error("Whisper model download did not return a response body.");
  const file = await fs.open(input.targetPath, "wx", 0o600);
  let sizeBytes = 0;
  try {
    try {
      while (true) {
        if (input.signal.aborted) throw new Error("Whisper model download was cancelled.");
        const { done, value } = await reader.read();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > input.maxBytes) {
          throw new Error("Whisper model download exceeds the configured byte limit.");
        }
        await file.write(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
  } catch (error) {
    await fs.rm(input.targetPath, { force: true });
    throw error;
  }
  if (sizeBytes < input.minBytes) {
    await fs.rm(input.targetPath, { force: true });
    throw new Error("Downloaded Whisper model is incomplete.");
  }
  await fs.chmod(input.targetPath, 0o600).catch(() => undefined);
  return sizeBytes;
}

async function resolveWhisperBinary(): Promise<string | null> {
  const configured = process.env.OPENPOND_WHISPER_CPP_BIN?.trim() || process.env.WHISPER_CPP_BIN?.trim();
  if (configured) return (await executableExists(configured)) ? configured : null;

  const candidates = [
    "whisper-cli",
    "whisper-cpp",
    "/opt/homebrew/bin/whisper-cli",
    "/opt/homebrew/bin/whisper-cpp",
    "/usr/local/bin/whisper-cli",
    "/usr/local/bin/whisper-cpp",
    "/usr/bin/whisper-cli",
    "/usr/bin/whisper-cpp",
  ];
  for (const candidate of candidates) {
    const resolved = candidate.includes(path.sep) ? candidate : await findExecutableOnPath(candidate);
    if (resolved && await executableExists(resolved)) return resolved;
  }
  return null;
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of paths) {
    const candidate = path.join(directory, command);
    if (await executableExists(candidate)) return candidate;
  }
  return null;
}

async function executableExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function whisperInstallHint(): string {
  if (process.platform === "darwin" || process.platform === "linux") {
    return "Could not auto-download whisper.cpp. Install it manually (e.g. `brew install whisper-cpp` on macOS or build from github.com/ggml-org/whisper.cpp), or set OPENPOND_WHISPER_CPP_BIN to the binary path.";
  }
  return "Local dictation requires whisper.cpp on macOS or Linux.";
}

export function getPlatformAssetInfo(): { assetName: string; archiveType: "tar.gz" | "zip" } | null {
  if (process.platform === "darwin") {
    return { assetName: "whisper-bin-x64.zip", archiveType: "zip" };
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      return { assetName: "whisper-bin-ubuntu-arm64.tar.gz", archiveType: "tar.gz" };
    }
    if (process.arch === "x64") {
      return { assetName: "whisper-bin-ubuntu-x64.tar.gz", archiveType: "tar.gz" };
    }
  }
  return null;
}

async function downloadAndExtractWhisperBinary(
  binaryDir: string,
  finalBinaryPath: string,
  assetInfo: { assetName: string; archiveType: "tar.gz" | "zip" },
  logger: VoiceLogger,
  signal: AbortSignal,
): Promise<string> {
  const url = `${WHISPER_CPP_RELEASE_BASE}/${assetInfo.assetName}`;
  await fs.mkdir(binaryDir, { recursive: true });
  const tempArchive = path.join(binaryDir, `whisper-archive.${process.pid}.${Date.now()}.tmp`);
  const extractDir = path.join(binaryDir, `extract-${process.pid}-${Date.now()}`);
  logger.info("downloading whisper binary", { url, targetDir: binaryDir });
  try {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download whisper binary: ${response.status} ${response.statusText}`.trim());
    }
    const sizeBytes = await streamBinaryResponseToFile({
      response,
      targetPath: tempArchive,
      signal,
      minBytes: BINARY_MIN_BYTES,
      maxBytes: BINARY_MAX_BYTES,
    });
    logger.info("whisper binary downloaded", { sizeBytes, extracting: true });

    await fs.mkdir(extractDir, { recursive: true });
    if (assetInfo.archiveType === "tar.gz") {
      await runExtractionCommand("tar", ["xzf", tempArchive, "-C", extractDir], signal);
    } else {
      await runExtractionCommand("unzip", ["-o", tempArchive, "-d", extractDir], signal);
    }

    const foundBinary = await findWhisperBinaryInDirectory(extractDir);
    if (!foundBinary) {
      throw new Error("whisper-cli binary not found in downloaded archive.");
    }

    // Move ALL files from the extraction directory into the binary directory
    // so that shared libraries (libwhisper.so, libggml.so, etc.) remain
    // alongside the executable. On Linux, whisper-cli is dynamically linked.
    await fs.mkdir(binaryDir, { recursive: true });
    await moveAllFiles(extractDir, binaryDir);
    await fs.chmod(finalBinaryPath, 0o755).catch(() => undefined);
    logger.info("whisper binary installed", { binaryPath: finalBinaryPath });
    return finalBinaryPath;
  } finally {
    await Promise.all([
      fs.rm(tempArchive, { force: true }),
      fs.rm(extractDir, { force: true, recursive: true }),
    ]);
  }
}

export async function streamBinaryResponseToFile(input: {
  response: Response;
  targetPath: string;
  signal: AbortSignal;
  minBytes: number;
  maxBytes: number;
}): Promise<number> {
  const declaredBytes = Number(input.response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > input.maxBytes) {
    throw new Error("Whisper binary download exceeds the configured byte limit.");
  }
  const reader = input.response.body?.getReader();
  if (!reader) throw new Error("Whisper binary download did not return a response body.");
  const file = await fs.open(input.targetPath, "wx", 0o600);
  let sizeBytes = 0;
  try {
    try {
      while (true) {
        if (input.signal.aborted) throw new Error("Whisper binary download was cancelled.");
        const { done, value } = await reader.read();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > input.maxBytes) {
          throw new Error("Whisper binary download exceeds the configured byte limit.");
        }
        await file.write(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
  } catch (error) {
    await fs.rm(input.targetPath, { force: true });
    throw error;
  }
  if (sizeBytes < input.minBytes) {
    await fs.rm(input.targetPath, { force: true });
    throw new Error("Downloaded whisper binary is incomplete.");
  }
  await fs.chmod(input.targetPath, 0o600).catch(() => undefined);
  return sizeBytes;
}

async function runExtractionCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Whisper binary extraction was cancelled."));
      return;
    }
    const child = execFile(command, args, { signal, maxBuffer: 10 * 1024 * 1024 }, (error) => {
      if (error) {
        reject(new Error(`Whisper binary extraction failed: ${error.message}`));
        return;
      }
      resolve();
    });
    if (child.exitCode === null && child.signalCode === null && signal.aborted) {
      child.kill("SIGTERM");
    }
  });
}

async function findWhisperBinaryInDirectory(directory: string): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findWhisperBinaryInDirectory(fullPath);
      if (found) return found;
    } else if (entry.isFile() && (entry.name === "whisper-cli" || entry.name === "whisper-cpp")) {
      if (await executableExists(fullPath)) return fullPath;
    }
  }
  return null;
}

async function moveAllFiles(srcDir: string, destDir: string): Promise<void> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await moveAllFiles(srcPath, destPath);
      await fs.rmdir(srcPath).catch(() => undefined);
    } else if (entry.isFile()) {
      await fs.rename(srcPath, destPath);
      // Make executables and shared libraries usable
      if (entry.name === "whisper-cli" || entry.name === "whisper-cpp") {
        await fs.chmod(destPath, 0o755).catch(() => undefined);
      } else if (entry.name.endsWith(".so") || entry.name.includes(".so.")) {
        await fs.chmod(destPath, 0o755).catch(() => undefined);
      }
    }
  }
}
