#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareTutorialNarration } from "./tutorial-narration.mjs";
import {
  renderTutorialTitlePoster,
  renderTutorialTwoBeatIntro,
} from "./tutorial-title-sequence.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(repoRoot, "apps/web/public/tutorials");
const assetDir = path.join(repoRoot, "scripts/tutorials/assets/profile-to-deployment");
const reportDir = path.join(repoRoot, "tmp/tutorial-exports/profile-to-deployment-build");
const workDir = path.join(reportDir, `.build-${process.pid}`);
const stagedDir = path.join(workDir, "public");
const slug = "profile-to-deployment";
const outputPath = path.join(stagedDir, `${slug}.mp4`);
const posterPath = path.join(stagedDir, `${slug}-poster.png`);
const captionsPath = path.join(stagedDir, `${slug}.vtt`);
const contactSheetPath = path.join(reportDir, `${slug}-contact-sheet.png`);
const receiptPath = path.join(reportDir, `${slug}-build.json`);
const transitionDuration = 0.35;
const args = parseArgs(process.argv.slice(2));

const title = "Train and deploy with OpenPond";
const subtitle = "Create a Profile. Build a Dataset. Launch on OpenPond infrastructure.";
const narrationConfig = {
  model: "gpt-4o-mini-tts-2025-12-15",
  voice: "cedar",
  speed: 1.1,
  responseFormat: "wav",
  instructions: "Warm, clear product tutorial narration. Speak at a calm conversational pace with practical emphasis. Pronounce OpenPond as open pond, CLI as C L I, GRPO as G R P O, and SFT as S F T. Finish each sentence cleanly. Avoid hype, sales cadence, dramatic delivery, or imitation of any real person.",
  leadInSeconds: 0.6,
  tailSeconds: 0.9,
  audioTitle: "AI-generated narration",
  audioCredit: "OpenAI Speech · Cedar voice",
};

const slides = [
  {
    id: "profile-create",
    eyebrow: "1 · PROFILE",
    title: "Create and validate a portable Profile",
    narration: "Begin with a Git-backed Profile. The app can create one from Profile settings, while the C L I can initialize the same source, show the active Profile, and run its checks.",
    kind: "terminal",
    terminalTitle: "Create and validate the Profile",
    commands: [
      "$ openpond init --path ./my-openpond-profile",
      "",
      "$ openpond profile current",
      "$ openpond profile check all",
      "",
      "$ openpond profile commit \"Add training harness\"",
    ],
  },
  {
    id: "harness-publish",
    eyebrow: "2 · HARNESS",
    title: "Publish the exact behavior you reviewed",
    narration: "The Profile is editable source. Check and commit it, then Sync publishes the exact agent, tools, environment, graders, and reward policy as an immutable Harness Release.",
    kind: "screenshot",
    screenshot: "profile-sync.png",
    calloutTitle: "From source to release",
    callouts: [
      "Check the Profile",
      "Commit the reviewed source",
      "Sync the hosted snapshot",
    ],
  },
  {
    id: "dataset-build",
    eyebrow: "3 · DATASET",
    title: "Build the Dataset from selected evidence",
    narration: "In Training, choose the chats, files, or imports that belong in the Dataset. Review disclosure, tasks, graders, and the separate train and frozen Eval boundaries before materializing it.",
    kind: "screenshot",
    screenshot: "dataset-builder.png",
    calloutTitle: "Review before freezing",
    callouts: [
      "Selected evidence",
      "Task and grader policy",
      "Train and frozen Eval",
    ],
  },
  {
    id: "manifest-pin",
    eyebrow: "4 · RUN MANIFEST",
    title: "Pin what will run before spending compute",
    narration: "A Harness Run Manifest binds the Harness and Dataset releases to one model revision, recipe, runtime, engine, and compute target. Launch the saved Model Run with that exact manifest.",
    kind: "terminal",
    terminalTitle: "Launch the saved release graph",
    commands: [
      "$ openpond training start model_run_… \\",
      "    --manifest ./run-manifest.json \\",
      "    --max-spend 10 \\",
      "    --retention-days 7",
    ],
  },
  {
    id: "model-configure",
    eyebrow: "5 · MODEL",
    title: "Resolve method, model, and compute together",
    narration: "In Lab, follow Goal, Dataset, Training Method, and Model. OpenPond resolves a compatible engine and compute target without provisioning anything until the final Run review.",
    kind: "screenshot",
    screenshot: "model-ready.png",
    calloutTitle: "Model setup",
    callouts: [
      "Choose the objective",
      "Attach the approved Dataset",
      "Select SFT, GRPO, or another method",
      "Review the compatible Model",
    ],
  },
  {
    id: "infrastructure-launch",
    eyebrow: "6 · COMPUTE",
    title: "Choose OpenPond Managed compute",
    narration: "OpenPond Managed prepares the training environment, resolves compatible accelerator capacity, and preserves the run's artifacts and receipts. You choose the training method and budget; OpenPond operates the infrastructure behind one stable compute option.",
    kind: "infrastructure",
    terminalTitle: "OpenPond Managed keeps the run portable",
    commands: [
      "$ openpond training watch run_…",
      "$ openpond training status run_… --json",
    ],
    layers: [
      ["COMPUTE", "OpenPond Managed"],
      ["ENVIRONMENT", "Prepared per run"],
      ["ACCELERATION", "Resolved for you"],
      ["RESULTS", "Artifacts + receipts"],
    ],
  },
  {
    id: "run-inspect",
    eyebrow: "7 · INSPECT",
    title: "Follow the canonical run from the C L I",
    narration: "Once launched, the app and C L I read the same control-plane record. Watch progress, stream logs, list artifacts, or request the full status as structured JSON.",
    kind: "terminal",
    terminalTitle: "Inspect the canonical run",
    commands: [
      "$ openpond training watch run_…",
      "",
      "$ openpond training logs run_…",
      "$ openpond training artifacts run_…",
      "",
      "$ openpond training status run_… --json",
    ],
  },
  {
    id: "promotion-review",
    eyebrow: "8 · PROMOTE",
    title: "Promote only after receipts and Eval pass",
    narration: "The result remains inspectable in Lab, but promotion stays blocked until frozen evaluation and lineage checks pass. That gate protects the exact Model artifact and compatible Harness Release.",
    kind: "screenshot",
    screenshot: "promotion-gate.png",
    calloutTitle: "Promotion gate",
    callouts: [
      "Inspect metrics and artifacts",
      "Verify frozen Eval",
      "Check release lineage",
      "Bind only the approved Model",
    ],
  },
];

if (args.markVisualQaPassed) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await Promise.all([
    stat(receipt.video.file),
    stat(receipt.poster),
    stat(receipt.captions),
    stat(receipt.contactSheet),
  ]);
  receipt.visualQaStatus = "passed";
  receipt.visualQaReviewedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${receiptPath}\n`);
  process.exit(0);
}

try {
  await rm(workDir, { force: true, recursive: true });
  await mkdir(stagedDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });

  const introPath = path.join(workDir, "intro.mp4");
  await renderTutorialTitlePoster({ outputPath: posterPath, subtitle, title });
  await renderTutorialTwoBeatIntro({ outputPath: introPath, posterPath, repoRoot });

  const screenshotData = new Map();
  for (const slide of slides.filter((item) => item.screenshot)) {
    if (screenshotData.has(slide.screenshot)) continue;
    const bytes = await readFile(path.join(assetDir, slide.screenshot));
    screenshotData.set(slide.screenshot, `data:image/png;base64,${bytes.toString("base64")}`);
  }

  const renderedSlides = [];
  for (const slide of slides) {
    const svgPath = path.join(workDir, `${slide.id}.svg`);
    const pngPath = path.join(workDir, `${slide.id}.png`);
    await writeFile(svgPath, renderSlideSvg(slide, screenshotData), "utf8");
    await execFileAsync("convert", [svgPath, pngPath]);
    renderedSlides.push({ ...slide, path: pngPath });
  }

  const outroPath = path.join(workDir, "outro.png");
  await renderOutro(outroPath);
  const narration = await prepareTutorialNarration({
    config: narrationConfig,
    envFile: args.envFile,
    frames: renderedSlides,
    reportDir,
  });
  const narrationById = new Map(narration.map((item) => [item.id, item]));
  const timeline = createTimeline({ introPath, narrationById, outroPath, renderedSlides });

  await writeFile(captionsPath, renderVtt(timeline), "utf8");
  const encodeArgs = ffmpegArgs({ outputPath, timeline });
  await execFileAsync("ffmpeg", encodeArgs, { maxBuffer: 24 * 1024 * 1024 });
  const probe = await probeVideo(outputPath);
  validateProbe(probe);

  const videoBytes = Number((await stat(outputPath)).size);
  if (videoBytes >= 15 * 1024 * 1024) {
    throw new Error(`Profile-to-deployment video is ${(videoBytes / 1024 / 1024).toFixed(2)} MiB; the limit is 15 MiB.`);
  }

  await renderContactSheet([
    posterPath,
    ...renderedSlides.map((slide) => slide.path),
    outroPath,
  ]);

  await mkdir(outDir, { recursive: true });
  for (const stagedPath of [outputPath, posterPath, captionsPath]) {
    await rename(stagedPath, path.join(outDir, path.basename(stagedPath)));
  }

  const publicVideoPath = path.join(outDir, `${slug}.mp4`);
  const publicBytes = await readFile(publicVideoPath);
  const receipt = {
    schemaVersion: "openpond.profileToDeploymentBuild.v1",
    generatedAt: new Date().toISOString(),
    title,
    subtitle,
    durationSeconds: Number(probe.format.duration),
    video: {
      file: publicVideoPath,
      bytes: publicBytes.length,
      sha256: sha256(publicBytes),
    },
    poster: path.join(outDir, `${slug}-poster.png`),
    captions: path.join(outDir, `${slug}.vtt`),
    contactSheet: contactSheetPath,
    narration: {
      ...narrationConfig,
      segments: narration.map(({ audioPath, ...segment }) => ({ ...segment, audioPath })),
    },
    timeline: timeline.map(({ audioPath: _audioPath, path: _path, ...segment }) => segment),
    probe,
    ffmpeg: {
      args: encodeArgs,
      version: (await execFileAsync("ffmpeg", ["-version"])).stdout.split("\n")[0],
    },
    visualQaStatus: "pending",
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [
    path.join(repoRoot, "scripts/tutorials/prepare-public-videos.mjs"),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    durationSeconds: receipt.durationSeconds,
    videoBytes,
    videoPath: publicVideoPath,
    posterPath: receipt.poster,
    captionsPath: receipt.captions,
    contactSheetPath,
    receiptPath,
  }, null, 2)}\n`);
} finally {
  await rm(workDir, { force: true, recursive: true });
}

function parseArgs(argv) {
  const result = { envFile: null, markVisualQaPassed: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mark-visual-qa-passed") {
      result.markVisualQaPassed = true;
      continue;
    }
    if (argv[index] !== "--env-file") throw new Error(`Unknown argument: ${argv[index]}`);
    result.envFile = argv[index + 1];
    if (!result.envFile) throw new Error("Missing value for --env-file.");
    index += 1;
  }
  return result;
}

function createTimeline({ introPath, narrationById, outroPath, renderedSlides }) {
  const timeline = [{
    id: "intro",
    kind: "intro",
    path: introPath,
    inputType: "video",
    duration: 4,
    start: 0,
    end: 4,
  }];
  for (const slide of renderedSlides) {
    const audio = narrationById.get(slide.id);
    if (!audio) throw new Error(`Narration is missing for ${slide.id}.`);
    const duration = Math.max(
      8,
      audio.duration + narrationConfig.leadInSeconds + narrationConfig.tailSeconds,
    );
    const start = timeline.at(-1).end - transitionDuration;
    timeline.push({
      ...slide,
      audioPath: audio.audioPath,
      audioDuration: audio.duration,
      duration,
      end: start + duration,
      inputType: "image",
      kind: "slide",
      start,
    });
  }
  const outroStart = timeline.at(-1).end - transitionDuration;
  timeline.push({
    id: "outro",
    kind: "outro",
    path: outroPath,
    inputType: "image",
    duration: 3.5,
    start: outroStart,
    end: outroStart + 3.5,
  });
  return timeline;
}

function renderSlideSvg(slide, screenshotData) {
  const titleLines = wrapText(slide.title, 46);
  const contentTop = titleLines.length > 1 ? 355 : 320;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#0d0f14"/>
  <circle cx="1800" cy="-30" r="360" fill="#102b36" opacity="0.5"/>
  <circle cx="70" cy="1080" r="290" fill="#13202d" opacity="0.7"/>
  <text x="120" y="105" fill="#67e8f9" font-family="DejaVu Sans" font-size="25" font-weight="700" letter-spacing="3">${svgEscape(slide.eyebrow)}</text>
  <text x="120" y="190" fill="#f7f7f8" font-family="DejaVu Sans" font-size="62" font-weight="700">
    ${titleLines.map((line, index) => `<tspan x="120" dy="${index === 0 ? 0 : 74}">${svgEscape(line)}</tspan>`).join("")}
  </text>
  <rect x="120" y="${contentTop - 28}" width="1680" height="3" fill="#263540"/>
  ${slideBody(slide, screenshotData, contentTop)}
</svg>`;
}

function slideBody(slide, screenshotData, top) {
  if (slide.kind === "terminal") {
    return terminalPanel({
      commands: slide.commands,
      height: 570,
      left: 150,
      title: slide.terminalTitle,
      top,
      width: 1620,
    });
  }
  if (slide.kind === "infrastructure") {
    const layerCards = slide.layers.map(([label, value], index) => {
      const x = 120 + (index * 425);
      return `
        <rect x="${x}" y="${top + 22}" width="380" height="128" rx="20" fill="${index === 2 ? "#10313b" : "#151e28"}" stroke="${index === 2 ? "#67e8f9" : "#2b3947"}" stroke-width="2"/>
        <text x="${x + 24}" y="${top + 65}" fill="#67e8f9" font-family="DejaVu Sans" font-size="18" font-weight="700" letter-spacing="2">${svgEscape(label)}</text>
        <text x="${x + 24}" y="${top + 112}" fill="#f7f7f8" font-family="DejaVu Sans" font-size="27" font-weight="700">${svgEscape(value)}</text>
      `;
    }).join("");
    return `
      ${layerCards}
      ${terminalPanel({
        commands: slide.commands,
        height: 390,
        left: 310,
        title: slide.terminalTitle,
        top: top + 205,
        width: 1300,
      })}
    `;
  }

  const image = screenshotData.get(slide.screenshot);
  if (!image) throw new Error(`Screenshot data is missing for ${slide.screenshot}.`);
  const callouts = slide.callouts.map((item, index) => `
    <circle cx="164" cy="${top + 180 + (index * 92)}" r="8" fill="#67e8f9"/>
    <text x="190" y="${top + 190 + (index * 92)}" fill="#d7dce2" font-family="DejaVu Sans" font-size="25">${svgEscape(item)}</text>
  `).join("");
  return `
    <rect x="120" y="${top + 24}" width="420" height="620" rx="26" fill="#151e28" stroke="#2b3947" stroke-width="2"/>
    <text x="160" y="${top + 100}" fill="#67e8f9" font-family="DejaVu Sans" font-size="22" font-weight="700" letter-spacing="2">${svgEscape(slide.calloutTitle.toUpperCase())}</text>
    ${callouts}
    <rect x="580" y="${top + 24}" width="1220" height="620" rx="26" fill="#08090b" stroke="#31404d" stroke-width="2"/>
    <clipPath id="clip-${slide.id}"><rect x="596" y="${top + 40}" width="1188" height="588" rx="16"/></clipPath>
    <image href="${image}" x="596" y="${top + 40}" width="1188" height="588" preserveAspectRatio="xMidYMid meet" clip-path="url(#clip-${slide.id})"/>
    <text x="1768" y="${top + 618}" text-anchor="end" fill="#8993a0" font-family="DejaVu Sans" font-size="18">OpenPond app</text>
  `;
}

function terminalPanel({ commands, height, left, title, top, width }) {
  const commandText = commands.map((command, index) => `
    <text x="${left + 55}" y="${top + 150 + (index * 62)}" fill="${command ? "#d8f9fd" : "#d8f9fd"}" font-family="DejaVu Sans Mono" font-size="27">${svgEscape(command || " ")}</text>
  `).join("");
  return `
    <rect x="${left}" y="${top}" width="${width}" height="${height}" rx="28" fill="#07090c" stroke="#22d3ee" stroke-width="2"/>
    <text x="${left + 55}" y="${top + 72}" fill="#22d3ee" font-family="DejaVu Sans Mono" font-size="28" font-weight="700">›_</text>
    <text x="${left + 125}" y="${top + 72}" fill="#f7f7f8" font-family="DejaVu Sans" font-size="25" font-weight="700">${svgEscape(title)}</text>
    <line x1="${left + 55}" y1="${top + 105}" x2="${left + width - 55}" y2="${top + 105}" stroke="#263540" stroke-width="2"/>
    ${commandText}
  `;
}

async function renderOutro(outputPath) {
  await execFileAsync("convert", [
    "-size", "1920x1080", "xc:#0d0f14",
    "-gravity", "North",
    "-fill", "#67e8f9", "-font", "DejaVu-Sans-Bold", "-pointsize", "28",
    "-draw", drawText(0, 360, "NEXT"),
    "-fill", "#f7f7f8", "-pointsize", "70",
    "-draw", drawText(0, 430, "Open Lab. Choose Model. Start Run."),
    "-fill", "#b6bbc5", "-font", "DejaVu-Sans", "-pointsize", "34",
    "-draw", drawText(0, 555, "Create, review, launch, and inspect your first training run."),
    outputPath,
  ]);
}

function ffmpegArgs({ outputPath, timeline }) {
  const ffmpeg = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const segment of timeline) {
    if (segment.inputType === "video") ffmpeg.push("-i", segment.path);
    else ffmpeg.push("-loop", "1", "-t", String(segment.duration), "-i", segment.path);
  }
  const narrated = timeline.filter((segment) => segment.kind === "slide");
  for (const segment of narrated) ffmpeg.push("-i", segment.audioPath);

  const filters = timeline.map((segment, index) => {
    const base = `[${index}:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`;
    if (segment.kind !== "slide") {
      return `${base},trim=duration=${segment.duration.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`;
    }
    return `${base},zoompan=z='min(zoom+0.0001,1.018)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=${segment.duration.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`;
  });

  let previous = "v0";
  for (let index = 1; index < timeline.length; index += 1) {
    const output = index === timeline.length - 1 ? "outv" : `x${index}`;
    filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${transitionDuration}:offset=${timeline[index].start.toFixed(3)}[${output}]`);
    previous = output;
  }

  const audioOffset = timeline.length;
  narrated.forEach((segment, index) => {
    const delayMs = Math.round(
      (segment.start + transitionDuration + narrationConfig.leadInSeconds) * 1000,
    );
    filters.push(`[${audioOffset + index}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}:all=1,volume=0.94[a${index}]`);
  });
  const duration = timeline.at(-1).end;
  filters.push(`${narrated.map((_, index) => `[a${index}]`).join("")}amix=inputs=${narrated.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`);
  ffmpeg.push(
    "-filter_complex", filters.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-metadata:s:a:0", `title=${narrationConfig.audioTitle}`,
    "-metadata:s:a:0", `handler_name=${narrationConfig.audioTitle}`,
    "-metadata:s:a:0", "language=eng",
    "-movflags", "+faststart",
    outputPath,
  );
  return ffmpeg;
}

function renderVtt(timeline) {
  const cues = timeline.filter((segment) => segment.kind === "slide");
  return [
    "WEBVTT",
    "",
    ...cues.flatMap((cue) => {
      const start = cue.start + transitionDuration + narrationConfig.leadInSeconds;
      return [
        cue.id,
        `${vttTime(start)} --> ${vttTime(start + cue.audioDuration)}`,
        cue.narration,
        "",
      ];
    }),
  ].join("\n");
}

async function probeVideo(videoPath) {
  return JSON.parse((await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=index,codec_name,codec_type,width,height,pix_fmt,r_frame_rate,sample_rate,channels:stream_tags=title,handler_name,language",
    "-of", "json",
    videoPath,
  ])).stdout);
}

function validateProbe(probe) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (
    !video
    || video.codec_name !== "h264"
    || video.width !== 1920
    || video.height !== 1080
    || video.pix_fmt !== "yuv420p"
    || video.r_frame_rate !== "30/1"
  ) {
    throw new Error(`Unexpected profile-to-deployment video stream: ${JSON.stringify(video)}`);
  }
  if (
    !audio
    || audio.codec_name !== "aac"
    || audio.sample_rate !== "48000"
    || audio.channels !== 2
  ) {
    throw new Error(`Unexpected profile-to-deployment audio stream: ${JSON.stringify(audio)}`);
  }
}

async function renderContactSheet(images) {
  await execFileAsync("gm", [
    "montage",
    "-background", "#101010",
    "-geometry", "480x270+10+10",
    "-tile", "4x",
    ...images,
    contactSheetPath,
  ]);
}

function wrapText(value, maximumCharacters) {
  const lines = [];
  let line = "";
  for (const word of String(value).split(/\s+/)) {
    if (!line || `${line} ${word}`.length <= maximumCharacters) {
      line = line ? `${line} ${word}` : word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

function drawText(x, y, value) {
  return `text ${x},${y} "${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function svgEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function vttTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
