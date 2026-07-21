import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const manifestFlagIndex = process.argv.indexOf("--manifest");
if (manifestFlagIndex >= 0 && !process.argv[manifestFlagIndex + 1]) {
  throw new Error("--manifest requires a path");
}
const manifestPath = resolve(
  scriptDir,
  manifestFlagIndex >= 0 ? process.argv[manifestFlagIndex + 1] : "manifest.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function parseArgs(argv) {
  const args = {
    all: false,
    sample: false,
    chapter: null,
    envFile: null,
    force: false,
    manifest: "manifest.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--all") args.all = true;
    else if (value === "--sample") args.sample = true;
    else if (value === "--force") args.force = true;
    else if (value === "--manifest") args.manifest = argv[++index];
    else if (value === "--chapter") args.chapter = argv[++index];
    else if (value === "--env-file") args.envFile = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!args.envFile) {
    throw new Error("--env-file is required");
  }
  if (![args.all, args.sample, Boolean(args.chapter)].some(Boolean)) {
    throw new Error("Choose --sample, --chapter <id>, or --all");
  }
  return args;
}

function readEnvValue(filePath, name) {
  const contents = readFileSync(filePath, "utf8");
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`,
    "m",
  );
  const match = contents.match(pattern);
  if (!match) return null;

  let value = match[1].trim();
  const isQuoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (isQuoted) value = value.slice(1, -1);
  return value;
}

function extractVoiceover(script, chapterId) {
  const start = `<!-- BEGIN VOICEOVER: ${chapterId} -->`;
  const end = "<!-- END VOICEOVER -->";
  const startIndex = script.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing voiceover marker for ${chapterId}`);
  const endIndex = script.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Missing end marker for ${chapterId}`);

  return script
    .slice(startIndex + start.length, endIndex)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function ensureDirectories() {
  for (const name of ["raw", "fitted"]) {
    mkdirSync(join(scriptDir, name), { recursive: true });
  }
}

function audioDuration(filePath) {
  const output = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8" },
  );
  return Number.parseFloat(output.trim());
}

function splitVoiceover(script, chapterId) {
  const paragraphs = extractVoiceover(script, chapterId)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return paragraphs.flatMap((paragraph) => {
    const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
    const beats = [];
    let current = [];
    let currentWords = 0;

    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).length;
      if (current.length > 0 && currentWords + sentenceWords > 36) {
        beats.push(current.join(" "));
        current = [];
        currentWords = 0;
      }
      current.push(sentence);
      currentWords += sentenceWords;
    }
    if (current.length > 0) beats.push(current.join(" "));
    return beats;
  });
}

function speechFingerprint(input) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: manifest.model,
        voice: manifest.voice,
        speed: manifest.speed,
        instructions: manifest.instructions,
        input,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

function concatEntry(filePath) {
  return `file '${resolve(filePath).replaceAll("'", "'\\''")}'`;
}

function createSilence({ durationSeconds, outputPath }) {
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=24000:cl=mono",
      "-t",
      durationSeconds.toFixed(6),
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    { stdio: "inherit" },
  );
}

async function createSpeech({ apiKey, input, outputPath }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: manifest.model,
      voice: manifest.voice,
      input,
      instructions: manifest.instructions,
      response_format: manifest.responseFormat,
      speed: manifest.speed,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Speech API returned ${response.status}: ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
}

function fitChapterAudio(chapter, rawPaths, fittedPath) {
  const assemblyDir = join(scriptDir, "fitted", "_assembly", chapter.id);
  mkdirSync(assemblyDir, { recursive: true });

  const rawDurations = rawPaths.map(audioDuration);
  const speechSeconds = rawDurations.reduce((sum, value) => sum + value, 0);
  const internalBreakCount = Math.max(0, rawPaths.length - 1);
  const breakBudget =
    chapter.durationSeconds -
    manifest.leadInSeconds -
    manifest.tailSeconds -
    speechSeconds;

  if (breakBudget < 0) {
    throw new Error(
      `${chapter.id} speech is ${Math.abs(breakBudget).toFixed(2)}s longer than its available window`,
    );
  }

  const breakSeconds =
    internalBreakCount > 0 ? breakBudget / internalBreakCount : 0;
  const leadPath = join(assemblyDir, "lead.wav");
  const breakPath = join(assemblyDir, "break.wav");
  const tailPath = join(assemblyDir, "tail.wav");
  createSilence({
    durationSeconds: manifest.leadInSeconds,
    outputPath: leadPath,
  });
  if (internalBreakCount > 0) {
    createSilence({ durationSeconds: breakSeconds, outputPath: breakPath });
  }
  createSilence({
    durationSeconds: manifest.tailSeconds,
    outputPath: tailPath,
  });

  const playlist = [concatEntry(leadPath)];
  rawPaths.forEach((rawPath, index) => {
    playlist.push(concatEntry(rawPath));
    if (index < rawPaths.length - 1) playlist.push(concatEntry(breakPath));
  });
  playlist.push(concatEntry(tailPath));

  const playlistPath = join(assemblyDir, "playlist.txt");
  const assembledPath = join(assemblyDir, "assembled.wav");
  writeFileSync(playlistPath, `${playlist.join("\n")}\n`);

  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      playlistPath,
      "-c",
      "copy",
      assembledPath,
    ],
    { stdio: "inherit" },
  );

  const loudness = manifest.loudness;

  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      assembledPath,
      "-af",
      [
        `loudnorm=I=${loudness.integratedLufs}:TP=${loudness.truePeakDb}:LRA=${loudness.rangeLu}`,
        `volume=${loudness.postGainDb}dB`,
        "apad",
        `atrim=duration=${chapter.durationSeconds}`,
      ].join(","),
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      fittedPath,
    ],
    { stdio: "inherit" },
  );

  const result = {
    segmentCount: rawPaths.length,
    speechSeconds,
    breakSeconds,
    fittedSeconds: audioDuration(fittedPath),
  };
  rmSync(assemblyDir, { recursive: true, force: true });
  return result;
}

function concatenateAndMux(chapters) {
  const fittedDir = join(scriptDir, "fitted");
  const playlistPath = join(fittedDir, "playlist.txt");
  const fullNarrationPath = resolve(
    scriptDir,
    manifest.narrationMaster ?? "full_narration.wav",
  );
  const playlist = chapters
    .map(({ id }) => concatEntry(join(fittedDir, `${id}.wav`)))
    .join("\n");
  writeFileSync(playlistPath, `${playlist}\n`);

  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      playlistPath,
      "-c",
      "copy",
      fullNarrationPath,
    ],
    { stdio: "inherit" },
  );

  const sourceVideo = resolve(scriptDir, manifest.sourceVideo);
  const outputVideo = resolve(scriptDir, manifest.outputVideo);
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourceVideo,
      "-i",
      fullNarrationPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-metadata:s:a:0",
      "title=AI-generated narration",
      "-metadata:s:a:0",
      "handler_name=AI-generated narration",
      "-metadata:s:a:0",
      "language=eng",
      "-movflags",
      "+faststart",
      "-shortest",
      outputVideo,
    ],
    { stdio: "inherit" },
  );

  return {
    fullNarrationPath,
    outputVideo,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve(args.envFile);
  if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);

  const apiKey = readEnvValue(envPath, "OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing or empty");

  ensureDirectories();

  if (args.sample) {
    const samplePath = join(scriptDir, "sample-cedar.wav");
    if (!existsSync(samplePath) || args.force) {
      await createSpeech({
        apiKey,
        input:
          "A policy is a probability distribution over possible actions. Post-training changes that distribution by routing evidence into an update. The important question is not only whether a response succeeded, but what information the training system preserved about why.",
        outputPath: samplePath,
      });
    } else {
      console.log(`Reusing existing voice sample: ${samplePath}`);
    }
    console.log(`Created voice sample: ${samplePath}`);
    return;
  }

  const sourceScriptPath = resolve(scriptDir, manifest.sourceScript);
  const narrationScript = readFileSync(sourceScriptPath, "utf8");
  const selectedChapters = args.all
    ? manifest.chapters
    : manifest.chapters.filter(({ id }) => id === args.chapter);

  if (selectedChapters.length === 0) {
    throw new Error(`Unknown chapter: ${args.chapter}`);
  }

  for (const chapter of selectedChapters) {
    const paragraphs = splitVoiceover(narrationScript, chapter.id);
    const rawDir = join(scriptDir, "raw", "segments", chapter.id);
    mkdirSync(rawDir, { recursive: true });
    const rawPaths = [];
    const fittedPath = join(scriptDir, "fitted", `${chapter.id}.wav`);
    const input = paragraphs.join("\n\n");
    console.log(
      `Generating ${chapter.id}: ${paragraphs.length} narration beats, ${input.split(/\s+/).length} words`,
    );

    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      const fingerprint = speechFingerprint(paragraph);
      const rawPath = join(
        rawDir,
        `${String(index + 1).padStart(3, "0")}-${fingerprint}.wav`,
      );
      rawPaths.push(rawPath);
      if (!existsSync(rawPath) || args.force) {
        console.log(
          `  Speech ${index + 1}/${paragraphs.length}: ${paragraph.split(/\s+/).length} words`,
        );
        await createSpeech({ apiKey, input: paragraph, outputPath: rawPath });
      } else {
        console.log(`  Reusing ${rawPath}`);
      }
    }

    const fit = fitChapterAudio(chapter, rawPaths, fittedPath);
    console.log(
      `${chapter.id}: ${fit.speechSeconds.toFixed(2)}s speech, ${fit.breakSeconds.toFixed(2)}s concept breaks, ${fit.fittedSeconds.toFixed(2)}s fitted`,
    );
  }

  if (args.all) {
    const outputs = concatenateAndMux(manifest.chapters);
    console.log(`Created narration track: ${outputs.fullNarrationPath}`);
    console.log(`Created narrated video: ${outputs.outputVideo}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
