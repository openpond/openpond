#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareTutorialNarration } from "./tutorial-narration.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaults = {
  report: path.join(repoRoot, "tmp/desktop-harness/account-agent-create-improve-e2e/report.json"),
  frames: path.join(repoRoot, "apps/web/src/components/get-started/how-to-make-an-agent.frames.json"),
  outDir: path.join(repoRoot, "apps/web/public/tutorials"),
  envFile: null,
};

const args = parseArgs(process.argv.slice(2));
if (args.markVisualQaPassed) {
  await markVisualQaPassed(args.report);
  process.exit(0);
}

const reportPath = path.resolve(args.report);
const frameManifestPath = path.resolve(args.frames);
const outDir = path.resolve(args.outDir);
const reportDir = path.dirname(reportPath);
const receiptPath = path.join(reportDir, "tutorial-build.json");
const contactSheetPath = path.join(reportDir, "tutorial-contact-sheet.png");
const workDir = path.join(reportDir, `.tutorial-build-${process.pid}`);
const stagedDir = path.join(workDir, "public");
const preparedDir = path.join(workDir, "frames");

try {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const manifest = JSON.parse(await readFile(frameManifestPath, "utf8"));
  const scenario = report.scenarios?.find((item) => item.name === "account-agent-create-improve-e2e");
  assert(report.ok === true && scenario?.ok === true, "Refusing to build from a failed Account Health scenario report.");
  assert(Array.isArray(manifest.frames) && manifest.frames.length > 0, "The tutorial manifest must contain at least one source frame.");
  assert(new Set(manifest.frames.map((frame) => frame.id)).size === manifest.frames.length, "Tutorial frame IDs must be unique.");
  assert(manifest.frames.every((frame) => typeof frame.narration === "string" && frame.narration.trim()), "Every tutorial frame needs narration.");
  assert(manifest.frames.every((frame) => validFocus(frame.focus)), "Every tutorial frame needs a normalized focus region.");

  const screenshotByName = new Map(
    (scenario.screenshots ?? []).map((sourcePath) => [path.basename(sourcePath).toLowerCase(), path.resolve(sourcePath)]),
  );
  assert(screenshotByName.size >= manifest.frames.length, `The passing scenario does not contain enough screenshots for the ${manifest.frames.length}-frame tutorial; found ${screenshotByName.size}.`);
  for (const frame of manifest.frames) {
    assert(screenshotByName.has(frame.file.toLowerCase()), `Scenario report is missing ${frame.id} (${frame.file}).`);
  }

  await rm(workDir, { force: true, recursive: true });
  await mkdir(preparedDir, { recursive: true });
  await mkdir(stagedDir, { recursive: true });

  const posterPath = path.join(stagedDir, "how-to-make-an-agent-poster.png");
  const outroPath = path.join(workDir, "outro.png");
  await renderSplashCard({
    outputPath: posterPath,
    title: manifest.tutorial.title,
    subtitle: manifest.tutorial.subtitle,
  });
  await renderSplashCard({
    outputPath: outroPath,
    title: manifest.tutorial.outroTitle,
    subtitle: manifest.tutorial.outroSubtitle,
  });

  const preparedFrames = [];
  for (const frame of manifest.frames) {
    const sourcePath = screenshotByName.get(frame.file.toLowerCase());
    const outputPath = path.join(preparedDir, `${frame.id}.png`);
    await prepareFrame(sourcePath, outputPath, frame, manifest.focusStyle);
    const sourceBytes = await readFile(sourcePath);
    const { width, height } = pngDimensions(sourceBytes);
    preparedFrames.push({
      ...frame,
      sourcePath,
      preparedPath: outputPath,
      sha256: sha256(sourceBytes),
      width,
      height,
    });
  }

  const narration = await prepareTutorialNarration({
    config: manifest.tutorial.narration,
    envFile: args.envFile,
    frames: preparedFrames,
    reportDir,
  });
  const narrationById = new Map(narration.map((item) => [item.id, item]));

  const segments = [{
    kind: "title",
    id: "title",
    label: manifest.tutorial.title,
    path: posterPath,
    duration: 4,
  }];
  const chapterTimes = {};
  for (const chapter of manifest.chapters) {
    const chapterCardPath = path.join(workDir, `chapter-${chapter.id}.png`);
    await renderChapterCard(chapterCardPath, chapter.label, manifest.tutorial.title);
    segments.push({
      kind: "chapter",
      id: `chapter-${chapter.id}`,
      chapter: chapter.id,
      label: chapter.label,
      path: chapterCardPath,
      duration: chapter.cardDuration,
    });
    for (const frame of preparedFrames.filter((candidate) => candidate.chapter === chapter.id)) {
      const audio = narrationById.get(frame.id);
      assert(audio, `Narration is missing for ${frame.id}.`);
      segments.push({
        kind: "frame",
        id: frame.id,
        chapter: chapter.id,
        label: frame.label,
        path: frame.preparedPath,
        duration: Math.max(
          manifest.frameMinimumDuration,
          audio.duration
            + manifest.tutorial.narration.leadInSeconds
            + manifest.tutorial.narration.tailSeconds
            + (manifest.transitionDuration * 2),
        ),
        caption: frame.caption,
        narration: frame.narration,
        audioPath: audio.audioPath,
        audioDuration: audio.duration,
        focus: frame.focus,
        narrow: frame.narrow === true,
        placement: frame.placement,
      });
    }
  }
  segments.push({
    kind: "outro",
    id: "outro",
    label: manifest.tutorial.outroTitle,
    path: outroPath,
    duration: 3,
  });

  const transition = manifest.transitionDuration;
  let cursor = 0;
  const timeline = segments.map((segment, index) => {
    const start = index === 0 ? 0 : cursor - transition;
    const end = start + segment.duration;
    cursor = end;
    if (segment.kind === "chapter") chapterTimes[segment.chapter] = start;
    return { ...segment, start, end };
  });

  const vttPath = path.join(stagedDir, "how-to-make-an-agent.vtt");
  await writeFile(vttPath, renderVtt(timeline), "utf8");
  const stagedVideoPath = path.join(stagedDir, "how-to-make-an-agent.mp4");
  const encodeArgs = ffmpegArgs({
    focusStyle: manifest.focusStyle,
    narration: manifest.tutorial.narration,
    outputPath: stagedVideoPath,
    timeline,
    transition,
  });
  const ffmpegVersion = (await execFileAsync("ffmpeg", ["-version"])).stdout.split("\n")[0];
  await execFileAsync("ffmpeg", encodeArgs, { maxBuffer: 16 * 1024 * 1024 });

  const probe = JSON.parse((await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=index,codec_name,codec_type,width,height,pix_fmt,r_frame_rate,sample_rate,channels:stream_tags=title,handler_name,language",
    "-of", "json",
    stagedVideoPath,
  ])).stdout);
  validateProbe(probe);
  const videoSize = Number((await stat(stagedVideoPath)).size);
  assert(videoSize < 25 * 1024 * 1024, `Tutorial video is ${(videoSize / 1024 / 1024).toFixed(2)} MiB; the limit is 25 MiB.`);

  await renderContactSheet(
    [posterPath, ...timeline.filter((item) => item.kind === "chapter").map((item) => item.path), ...preparedFrames.map((frame) => frame.preparedPath), outroPath],
    contactSheetPath,
  );

  const stagedOutputs = [
    stagedVideoPath,
    posterPath,
    vttPath,
  ];
  const outputMetadata = await Promise.all(stagedOutputs.map(async (outputPath) => {
    const bytes = await readFile(outputPath);
    return { file: path.basename(outputPath), sha256: sha256(bytes), bytes: bytes.length };
  }));
  const receipt = {
    schemaVersion: "openpond.tutorialBuild.v2",
    generatedAt: new Date().toISOString(),
    scenarioReport: reportPath,
    scenarioPassed: true,
    frameManifest: frameManifestPath,
    frames: preparedFrames.map(({ preparedPath: _preparedPath, ...frame }) => frame),
    title: manifest.tutorial,
    chapters: manifest.chapters.map((chapter) => ({ ...chapter, start: chapterTimes[chapter.id] })),
    timeline: timeline.map((segment) => ({
      kind: segment.kind,
      id: segment.id,
      chapter: segment.chapter ?? null,
      label: segment.label,
      start: segment.start,
      end: segment.end,
      duration: segment.duration,
      narration: segment.narration ?? null,
      focus: segment.focus ?? null,
    })),
    outro: { duration: 3 },
    transitionDuration: transition,
    narration: {
      ...manifest.tutorial.narration,
      segments: narration.map(({ audioPath, ...item }) => ({ ...item, audioPath })),
    },
    ffmpeg: { version: ffmpegVersion, args: encodeArgs },
    probe,
    durationSeconds: Number(probe.format.duration),
    outputs: outputMetadata,
    contactSheet: contactSheetPath,
    visualQaStatus: "pending",
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  await mkdir(outDir, { recursive: true });
  for (const stagedPath of stagedOutputs) {
    await rename(stagedPath, path.join(outDir, path.basename(stagedPath)));
  }
  await execFileAsync(process.execPath, [
    path.join(repoRoot, "scripts/tutorials/prepare-public-videos.mjs"),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    durationSeconds: receipt.durationSeconds,
    videoBytes: videoSize,
    receiptPath,
    contactSheetPath,
    outputs: outputMetadata.map((item) => path.join(outDir, item.file)),
  }, null, 2)}\n`);
} finally {
  await rm(workDir, { force: true, recursive: true });
}

function parseArgs(argv) {
  const parsed = { ...defaults, markVisualQaPassed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mark-visual-qa-passed") {
      parsed.markVisualQaPassed = true;
      continue;
    }
    const key = value === "--report"
      ? "report"
      : value === "--frames"
        ? "frames"
        : value === "--out-dir"
          ? "outDir"
          : value === "--env-file"
            ? "envFile"
            : null;
    if (!key) throw new Error(`Unknown argument: ${value}`);
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value for ${value}.`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function markVisualQaPassed(reportInput) {
  const receiptPath = path.join(path.dirname(path.resolve(reportInput)), "tutorial-build.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await stat(receipt.contactSheet);
  receipt.visualQaStatus = "passed";
  receipt.visualQaReviewedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${receiptPath}\n`);
}

async function renderSplashCard({ outputPath, title, subtitle }) {
  const wordmark = path.join(repoRoot, "apps/web/public/openpond-wordlogo-white.png");
  const resizedWordmark = `${outputPath}.wordmark.png`;
  const baseCard = `${outputPath}.base.png`;
  try {
    await execFileAsync("convert", [wordmark, "-resize", "420x72", resizedWordmark]);
    await execFileAsync("convert", [
      "-size", "1920x1080", "xc:#101010",
      "-gravity", "North", "-font", "DejaVu-Sans", "-fill", "#f7f7f8", "-pointsize", "54", "-draw", drawText(0, 500, title),
      "-fill", "#929292", "-pointsize", "25", "-draw", drawText(0, 585, subtitle),
      baseCard,
    ]);
    await execFileAsync("composite", ["-geometry", "+750+304", resizedWordmark, baseCard, outputPath]);
  } finally {
    await Promise.all([
      rm(resizedWordmark, { force: true }),
      rm(baseCard, { force: true }),
    ]);
  }
}

async function renderChapterCard(outputPath, chapter, tutorialTitle) {
  const icon = path.join(repoRoot, "apps/web/public/openpond-icon.png");
  const resizedIcon = `${outputPath}.icon.png`;
  const baseCard = `${outputPath}.base.png`;
  try {
    await execFileAsync("convert", [icon, "-resize", "76x76", resizedIcon]);
    await execFileAsync("convert", [
      "-size", "1920x1080", "xc:#101010",
      "-gravity", "North", "-font", "DejaVu-Sans", "-fill", "#22d3ee", "-pointsize", "26", "-draw", drawText(0, 365, tutorialTitle),
      "-fill", "#f7f7f8", "-pointsize", "72", "-draw", drawText(0, 430, chapter),
      baseCard,
    ]);
    await execFileAsync("composite", ["-geometry", "+922+250", resizedIcon, baseCard, outputPath]);
  } finally {
    await Promise.all([
      rm(resizedIcon, { force: true }),
      rm(baseCard, { force: true }),
    ]);
  }
}

async function prepareFrame(sourcePath, outputPath, frame, focusStyle) {
  const focus = pixelFocus(frame.focus);
  const dimFill = `#000000${opacityHex(focusStyle.dimOpacity)}`;
  const args = [
    sourcePath,
    "-resize", "1920x1080",
    "-background", "#101010",
    "-gravity", "Center",
    "-extent", "1920x1080",
    "-gravity", "NorthWest",
    "-fill", dimFill,
    "-stroke", "none",
    "-draw", `rectangle 0,0 1920,${focus.y}`,
    "-draw", `rectangle 0,${focus.y + focus.height} 1920,1080`,
    "-draw", `rectangle 0,${focus.y} ${focus.x},${focus.y + focus.height}`,
    "-draw", `rectangle ${focus.x + focus.width},${focus.y} 1920,${focus.y + focus.height}`,
    "-fill", "none",
    "-stroke", focusStyle.borderColor,
    "-strokewidth", String(focusStyle.borderWidth),
    "-draw", `roundrectangle ${focus.x},${focus.y} ${focus.x + focus.width},${focus.y + focus.height} 14,14`,
  ];
  args.push(outputPath);
  await execFileAsync("convert", args);
}

function ffmpegArgs({ focusStyle, narration, outputPath, timeline, transition }) {
  const args = ["-y"];
  for (const segment of timeline) {
    args.push("-loop", "1", "-t", String(segment.duration), "-i", segment.path);
  }
  const narratedSegments = timeline.filter((segment) => segment.kind === "frame");
  for (const segment of narratedSegments) args.push("-i", segment.audioPath);

  const filters = timeline.map((segment, index) => frameVideoFilter(segment, index, focusStyle));
  let previous = "v0";
  for (let index = 1; index < timeline.length; index += 1) {
    const output = index === timeline.length - 1 ? "outv" : `x${index}`;
    filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${transition}:offset=${timeline[index].start.toFixed(3)}[${output}]`);
    previous = output;
  }

  const audioInputOffset = timeline.length;
  narratedSegments.forEach((segment, index) => {
    const delayMs = Math.round((segment.start + transition + narration.leadInSeconds) * 1000);
    filters.push(
      `[${audioInputOffset + index}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}:all=1,volume=0.94[a${index}]`,
    );
  });
  const tutorialDuration = timeline.at(-1).end;
  filters.push(
    `${narratedSegments.map((_, index) => `[a${index}]`).join("")}amix=inputs=${narratedSegments.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${tutorialDuration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`,
  );

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[outv]",
    "-map", "[outa]",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-metadata:s:a:0", `title=${narration.audioTitle}`,
    "-metadata:s:a:0", `handler_name=${narration.audioTitle}`,
    "-metadata:s:a:0", "language=eng",
    "-movflags", "+faststart",
    outputPath,
  );
  return args;
}

function frameVideoFilter(segment, index, focusStyle) {
  const prefix = `[${index}:v]fps=30,format=yuv420p,setsar=1`;
  if (segment.kind !== "frame") return `${prefix},setpts=PTS-STARTPTS[v${index}]`;

  const focus = pixelFocus(segment.focus);
  const delayFrames = Math.round(focusStyle.zoomDelaySeconds * 30);
  const zoomFrames = Math.max(1, Math.round(focusStyle.zoomDurationSeconds * 30));
  const endFrame = delayFrames + zoomFrames;
  const zoomStep = ((segment.focus.zoom - 1) / zoomFrames).toFixed(8);
  const targetZoom = segment.focus.zoom.toFixed(5);
  const centerX = (focus.x + (focus.width / 2)).toFixed(3);
  const centerY = (focus.y + (focus.height / 2)).toFixed(3);
  const labelTop = segment.placement === "top-left" ? 42 : 976;
  const filters = [
    prefix,
    `zoompan=z='if(lte(on,${delayFrames}),1,if(lte(on,${endFrame}),1+(on-${delayFrames})*${zoomStep},${targetZoom}))':x='max(0,min(iw-iw/zoom,${centerX}-iw/(2*zoom)))':y='max(0,min(ih-ih/zoom,${centerY}-ih/(2*zoom)))':d=1:s=1920x1080:fps=30`,
    `trim=duration=${segment.duration.toFixed(3)}`,
    "setpts=PTS-STARTPTS",
    `drawbox=x=55:y=${labelTop}:w=875:h=64:color=black@0.78:t=fill`,
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${ffmpegText(segment.label)}':fontcolor=white:fontsize=31:x=76:y=${labelTop + 14}`,
  ];
  return `${filters.join(",")}[v${index}]`;
}

function ffmpegText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%");
}

function pixelFocus(focus) {
  return {
    x: Math.round(focus.x * 1920),
    y: Math.round(focus.y * 1080),
    width: Math.round(focus.width * 1920),
    height: Math.round(focus.height * 1080),
  };
}

function opacityHex(opacity) {
  return Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function validFocus(focus) {
  return focus
    && [focus.x, focus.y, focus.width, focus.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && focus.width > 0
    && focus.height > 0
    && focus.x + focus.width <= 1
    && focus.y + focus.height <= 1
    && Number.isFinite(focus.zoom)
    && focus.zoom >= 1
    && focus.zoom <= 2;
}

function renderVtt(timeline) {
  const cues = timeline.filter((segment) => segment.kind === "frame");
  return [
    "WEBVTT",
    "",
    ...cues.flatMap((cue) => [
      cue.id,
      `${vttTime(cue.start)} --> ${vttTime(cue.end - 0.05)}`,
      cue.caption,
      "",
    ]),
  ].join("\n");
}

async function renderContactSheet(images, outputPath) {
  await execFileAsync("gm", [
    "montage",
    "-background", "#101010",
    "-geometry", "320x180+8+8",
    "-tile", "4x",
    ...images,
    outputPath,
  ], { maxBuffer: 8 * 1024 * 1024 });
}

function validateProbe(probe) {
  const videoStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "video");
  const audioStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
  assert(videoStreams.length === 1, `Expected one video stream, found ${videoStreams.length}.`);
  assert(audioStreams.length === 1, `Expected one narrated audio stream, found ${audioStreams.length}.`);
  const video = videoStreams[0];
  assert(video.codec_name === "h264", `Expected H.264, found ${video.codec_name}.`);
  assert(video.width === 1920 && video.height === 1080, `Expected 1920x1080, found ${video.width}x${video.height}.`);
  assert(video.pix_fmt === "yuv420p", `Expected yuv420p, found ${video.pix_fmt}.`);
  assert(video.r_frame_rate === "30/1", `Expected 30 fps, found ${video.r_frame_rate}.`);
  const audio = audioStreams[0];
  assert(audio.codec_name === "aac", `Expected AAC narration, found ${audio.codec_name}.`);
  assert(audio.sample_rate === "48000", `Expected 48 kHz narration, found ${audio.sample_rate}.`);
  assert(audio.channels === 2, `Expected stereo narration, found ${audio.channels} channels.`);
  assert(Number.isFinite(Number(probe.format?.duration)) && Number(probe.format.duration) > 0, "Tutorial duration is invalid.");
}

function pngDimensions(bytes) {
  assert(bytes.subarray(1, 4).toString("ascii") === "PNG", "Expected a PNG screenshot.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function drawText(x, y, value) {
  const escaped = String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `text ${x},${y} "${escaped}"`;
}

function vttTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
