import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
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

export function createVoiceTranscriptionService(input: {
  storeDir: string;
  logger: VoiceLogger;
}): {
  status: () => Promise<VoiceTranscriptionStatus>;
  transcribe: (payload: unknown) => Promise<VoiceTranscriptionResponse>;
} {
  const modelName = normalizedModelName(process.env.OPENPOND_WHISPER_MODEL_NAME);
  const modelPath =
    process.env.OPENPOND_WHISPER_MODEL?.trim() ||
    path.join(input.storeDir, "voice-models", `ggml-${modelName}.bin`);
  let modelDownload: Promise<string> | null = null;

  async function status(): Promise<VoiceTranscriptionStatus> {
    const binaryPath = await resolveWhisperBinary();
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

  async function ensureModel(): Promise<string> {
    if (await fileExists(modelPath)) return modelPath;
    if (process.env.OPENPOND_WHISPER_MODEL?.trim()) {
      throw new Error(`Whisper model not found at ${modelPath}.`);
    }
    if (!canDownloadDefaultModel()) {
      throw new Error("Automatic Whisper model download is disabled for this model.");
    }
    if (!modelDownload) {
      modelDownload = downloadDefaultModel(modelPath, modelName, input.logger).finally(() => {
        modelDownload = null;
      });
    }
    return modelDownload;
  }

  async function transcribe(payload: unknown): Promise<VoiceTranscriptionResponse> {
    const request = parseVoiceTranscriptionRequest(payload);
    const binaryPath = await resolveWhisperBinary();
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

  return { status, transcribe };
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
    const child = spawn(input.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, TRANSCRIPTION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
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
): Promise<string> {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  logger.info("downloading whisper model", { modelName, targetPath });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download Whisper model: ${response.status} ${response.statusText}`.trim());
  }
  await fs.writeFile(tempPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const stat = await fs.stat(tempPath);
  if (stat.size < MODEL_MIN_BYTES) {
    await fs.rm(tempPath, { force: true });
    throw new Error("Downloaded Whisper model is incomplete.");
  }
  await fs.rename(tempPath, targetPath);
  await fs.chmod(targetPath, 0o600).catch(() => undefined);
  logger.info("whisper model downloaded", { modelName, targetPath, sizeBytes: stat.size });
  return targetPath;
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
  if (process.platform === "darwin") {
    return "Install whisper.cpp with `brew install whisper-cpp`, then try dictation again.";
  }
  if (process.platform === "linux") {
    return "Install whisper.cpp and make `whisper-cli` available on PATH, or set OPENPOND_WHISPER_CPP_BIN.";
  }
  return "Local dictation requires whisper.cpp on macOS or Linux.";
}
