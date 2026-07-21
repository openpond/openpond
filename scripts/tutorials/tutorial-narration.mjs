import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function prepareTutorialNarration({
  config,
  envFile,
  frames,
  reportDir,
}) {
  assertNarrationConfig(config);
  const rawDir = path.join(reportDir, "tutorial-narration", "raw");
  await mkdir(rawDir, { recursive: true });

  const pending = frames.map((frame) => ({
    ...frame,
    fingerprint: speechFingerprint(config, frame.narration),
  }));
  const missing = [];
  for (const frame of pending) {
    const audioPath = narrationPath(rawDir, frame);
    try {
      await stat(audioPath);
    } catch {
      missing.push({ ...frame, audioPath });
    }
  }

  let apiKey = null;
  if (missing.length > 0) {
    assert(envFile, `Narration requires --env-file because ${missing.length} cached speech segments are missing.`);
    apiKey = await readEnvValue(path.resolve(envFile), "OPENAI_API_KEY");
    assert(apiKey, "OPENAI_API_KEY is missing or empty in the narration environment file.");
  }

  for (const frame of pending) {
    const audioPath = narrationPath(rawDir, frame);
    if (missing.some((candidate) => candidate.id === frame.id)) {
      process.stdout.write(`Narrating ${frame.id}: ${frame.narration.split(/\s+/).length} words\n`);
      await createSpeech({ apiKey, config, input: frame.narration, outputPath: audioPath });
    } else {
      process.stdout.write(`Reusing narration ${path.basename(audioPath)}\n`);
    }
  }

  return Promise.all(pending.map(async (frame) => {
    const audioPath = narrationPath(rawDir, frame);
    const bytes = await readFile(audioPath);
    return {
      id: frame.id,
      audioPath,
      duration: await audioDuration(audioPath),
      fingerprint: frame.fingerprint,
      sha256: sha256(bytes),
      bytes: bytes.length,
      text: frame.narration,
    };
  }));
}

function narrationPath(rawDir, frame) {
  return path.join(rawDir, `${frame.id}-${frame.fingerprint}.wav`);
}

function speechFingerprint(config, input) {
  return createHash("sha256")
    .update(JSON.stringify({
      model: config.model,
      voice: config.voice,
      speed: config.speed,
      instructions: config.instructions,
      responseFormat: config.responseFormat,
      input,
    }))
    .digest("hex")
    .slice(0, 12);
}

async function createSpeech({ apiKey, config, input, outputPath }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      voice: config.voice,
      input,
      instructions: config.instructions,
      response_format: config.responseFormat,
      speed: config.speed,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Speech API returned ${response.status}: ${body}`);
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

async function audioDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  assert(Number.isFinite(duration) && duration > 0, `Narration duration is invalid: ${filePath}`);
  return duration;
}

async function readEnvValue(filePath, name) {
  const contents = await readFile(filePath, "utf8");
  const match = contents.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`, "m"));
  if (!match) return null;
  let value = match[1].trim();
  const quoted = (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"));
  if (quoted) value = value.slice(1, -1);
  return value;
}

function assertNarrationConfig(config) {
  assert(config && typeof config === "object", "Tutorial narration config is required.");
  for (const key of ["model", "voice", "instructions", "responseFormat"]) {
    assert(typeof config[key] === "string" && config[key].trim(), `Narration ${key} is required.`);
  }
  assert(Number.isFinite(config.speed) && config.speed > 0, "Narration speed must be positive.");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
