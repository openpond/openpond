#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareTutorialNarration } from "./tutorial-narration.mjs";
import {
  renderTutorialIntro,
  renderTutorialTitlePoster,
} from "./tutorial-title-sequence.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(repoRoot, "apps/web/public/tutorials");
const reportDir = path.join(repoRoot, "tmp/tutorial-exports/openpond-agent-overview-build");
const workDir = path.join(reportDir, `.build-${process.pid}`);
const stagedDir = path.join(workDir, "public");
const slug = "what-is-an-openpond-agent";
const outputPath = path.join(stagedDir, `${slug}.mp4`);
const posterPath = path.join(stagedDir, `${slug}-poster.png`);
const captionsPath = path.join(stagedDir, `${slug}.vtt`);
const contactSheetPath = path.join(reportDir, `${slug}-contact-sheet.png`);
const receiptPath = path.join(reportDir, `${slug}-build.json`);
const args = parseArgs(process.argv.slice(2));
if (args.markVisualQaPassed) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await Promise.all([stat(receipt.video.file), stat(receipt.poster), stat(receipt.captions), stat(receipt.contactSheet)]);
  receipt.visualQaStatus = "passed";
  receipt.visualQaReviewedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${receiptPath}\n`);
  process.exit(0);
}
const envFile = args.envFile;

const title = "What is an OpenPond Agent?";
const subtitle = "A Profile capability you can chat with or run directly.";
const transitionDuration = 0.35;
const narrationConfig = {
  model: "gpt-4o-mini-tts-2025-12-15",
  voice: "cedar",
  speed: 1.12,
  responseFormat: "wav",
  instructions: "Warm, clear product tutorial narration. Speak at a calm conversational pace with practical emphasis on how people use Agents. Pronounce OpenPond as open pond, API as A P I, and MCP as M C P. Finish each sentence cleanly. Avoid hype, sales cadence, dramatic delivery, or imitation of any real person.",
  leadInSeconds: 0.6,
  tailSeconds: 0.85,
  audioTitle: "AI-generated narration",
  audioCredit: "OpenAI Speech · Cedar voice",
};

const slides = [
  {
    id: "overview-profile",
    eyebrow: "PROFILE",
    title: "Agents live in your Profile",
    narration: "An OpenPond Agent is a reusable capability that lives in your Profile. Its source defines its purpose, the actions people can run, and the checks that protect its behavior.",
    kind: "profile",
  },
  {
    id: "overview-entrypoints",
    eyebrow: "TWO WAYS TO USE IT",
    title: "Chat or run a direct action",
    narration: "Use chat when the request is open ended and conversational. Use a direct action when the inputs and result should be explicit, repeatable, and easy to connect to another workflow.",
    kind: "entrypoints",
  },
  {
    id: "overview-surfaces",
    eyebrow: "ONE ACTION CATALOG",
    title: "The same Agent can meet you in different places",
    narration: "A shared action catalog lets the Agent appear in OpenPond chat, its Agent page, supported channels, and API or M C P integrations without duplicating the underlying behavior.",
    kind: "surfaces",
  },
  {
    id: "overview-example",
    eyebrow: "REAL-WORLD EXAMPLE",
    title: "Account Health Agent",
    narration: "An Account Health Agent can answer follow up questions in chat, summarize one account, triage renewal risk, or build a weekly portfolio review. Each path uses the same trusted Agent source.",
    kind: "example",
  },
  {
    id: "overview-checks",
    eyebrow: "CHECKS",
    title: "Improve behavior with evidence",
    narration: "Checks run repeatable scenarios against the Agent's behavior and outputs. During Improve, OpenPond compares the candidate with the active Agent and only releases the change after the required checks pass.",
    kind: "checks",
  },
  {
    id: "overview-lifecycle",
    eyebrow: "THE AGENT LOOP",
    title: "Create, use, and improve",
    narration: "Start from a purpose or supporting chats, review what OpenPond will build, use the Agent on real work, then improve it from the evidence. Next, create the Account Health Agent step by step.",
    kind: "lifecycle",
  },
];

try {
  await rm(workDir, { force: true, recursive: true });
  await mkdir(stagedDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });

  const introPath = path.join(workDir, "intro.mp4");
  await renderTutorialTitlePoster({ outputPath: posterPath, subtitle, title });
  await renderTutorialIntro({ outputPath: introPath, posterPath, repoRoot, subtitle, title });

  const renderedSlides = [];
  for (const slide of slides) {
    const svgPath = path.join(workDir, `${slide.id}.svg`);
    const pngPath = path.join(workDir, `${slide.id}.png`);
    await writeFile(svgPath, renderSlideSvg(slide), "utf8");
    await execFileAsync("convert", [svgPath, pngPath]);
    renderedSlides.push({ ...slide, path: pngPath });
  }

  const outroPath = path.join(workDir, "outro.png");
  await renderOutro(outroPath);
  const narration = await prepareTutorialNarration({
    config: narrationConfig,
    envFile,
    frames: renderedSlides,
    reportDir,
  });
  const narrationById = new Map(narration.map((item) => [item.id, item]));
  const timeline = createTimeline({ introPath, narrationById, outroPath, renderedSlides });

  await writeFile(captionsPath, renderVtt(timeline), "utf8");
  await execFileAsync("ffmpeg", ffmpegArgs({ outputPath, timeline }), {
    maxBuffer: 16 * 1024 * 1024,
  });
  const probe = await probeVideo(outputPath);
  validateProbe(probe);
  const videoBytes = Number((await stat(outputPath)).size);
  if (videoBytes >= 15 * 1024 * 1024) {
    throw new Error(`Agent overview is ${(videoBytes / 1024 / 1024).toFixed(2)} MiB; the limit is 15 MiB.`);
  }
  await renderContactSheet([posterPath, ...renderedSlides.map((slide) => slide.path), outroPath]);

  await mkdir(outDir, { recursive: true });
  for (const stagedPath of [outputPath, posterPath, captionsPath]) {
    await rename(stagedPath, path.join(outDir, path.basename(stagedPath)));
  }
  const publicVideoPath = path.join(outDir, `${slug}.mp4`);
  const publicBytes = await readFile(publicVideoPath);
  const receipt = {
    schemaVersion: "openpond.agentOverviewBuild.v1",
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
    visualQaStatus: "pending",
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [path.join(repoRoot, "scripts/tutorials/prepare-public-videos.mjs")]);
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
    const duration = Math.max(8, audio.duration + narrationConfig.leadInSeconds + narrationConfig.tailSeconds);
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

async function renderOutro(outputPath) {
  await execFileAsync("convert", [
    "-size", "1920x1080", "xc:#0d0f14",
    "-gravity", "North",
    "-fill", "#67e8f9", "-font", "DejaVu-Sans-Bold", "-pointsize", "28",
    "-draw", drawText(0, 370, "NEXT"),
    "-fill", "#f7f7f8", "-pointsize", "70", "-draw", drawText(0, 430, "Create your first Agent"),
    "-fill", "#b6bbc5", "-font", "DejaVu-Sans", "-pointsize", "34",
    "-draw", drawText(0, 555, "Continue with How to make an agent."),
    outputPath,
  ]);
}

function renderSlideSvg(slide) {
  const content = slideContent(slide.kind);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#0d0f14"/>
  <circle cx="1770" cy="-20" r="340" fill="#102b36" opacity="0.55"/>
  <circle cx="80" cy="1080" r="300" fill="#13202d" opacity="0.72"/>
  <text x="160" y="150" fill="#67e8f9" font-family="DejaVu Sans" font-size="27" font-weight="700" letter-spacing="4">${svgEscape(slide.eyebrow)}</text>
  <text x="160" y="245" fill="#f7f7f8" font-family="DejaVu Sans" font-size="66" font-weight="700">${svgEscape(slide.title)}</text>
  <rect x="160" y="298" width="1600" height="3" fill="#22313b"/>
  ${content}
</svg>`;
}

function slideContent(kind) {
  if (kind === "profile") {
    return `
      ${panel(180, 390, 690, 460, "PROFILE SOURCE", "Owned, versioned, and reusable", ["agent/agent.ts", "agent/actions/*", "agent/evals/*"], "#17212b")}
      ${arrow(900, 620, 1015, 620)}
      ${panel(1050, 390, 690, 460, "AGENT", "Purpose + action catalog + checks", ["chat", "direct actions", "required checks"], "#10252d")}
    `;
  }
  if (kind === "entrypoints") {
    return `
      ${panel(180, 380, 740, 470, "CHAT", "Open-ended, conversational work", ["Ask follow-up questions", "Share context naturally", "Route to the right capability"], "#17212b")}
      ${panel(1000, 380, 740, 470, "DIRECT ACTION", "Explicit, repeatable execution", ["Typed inputs", "Predictable output", "Easy workflow integration"], "#10252d")}
    `;
  }
  if (kind === "surfaces") {
    return `
      ${smallNode(180, 410, 400, 160, "OPENPOND CHAT", "Natural-language requests")}
      ${smallNode(180, 675, 400, 160, "SUPPORTED CHANNELS", "Shared chat ingress")}
      ${smallNode(1340, 410, 400, 160, "AGENT PAGE", "Chat and action forms")}
      ${smallNode(1340, 675, 400, 160, "API / MCP", "Programmatic execution")}
      ${arrow(600, 490, 785, 565)}${arrow(600, 755, 785, 650)}
      ${arrow(1320, 490, 1135, 565)}${arrow(1320, 755, 1135, 650)}
      <rect x="780" y="500" width="360" height="230" rx="28" fill="#10252d" stroke="#67e8f9" stroke-width="3"/>
      <text x="960" y="590" text-anchor="middle" fill="#67e8f9" font-family="DejaVu Sans" font-size="23" font-weight="700" letter-spacing="2">AGENT</text>
      <text x="960" y="645" text-anchor="middle" fill="#f7f7f8" font-family="DejaVu Sans" font-size="34" font-weight="700">Action catalog</text>
      <text x="960" y="688" text-anchor="middle" fill="#aab3bf" font-family="DejaVu Sans" font-size="22">One runtime surface</text>
    `;
  }
  if (kind === "example") {
    return `
      <rect x="180" y="370" width="1540" height="500" rx="30" fill="#121922" stroke="#273544" stroke-width="2"/>
      <text x="245" y="455" fill="#67e8f9" font-family="DejaVu Sans" font-size="25" font-weight="700">DEFAULT CHAT</text>
      <text x="245" y="510" fill="#f7f7f8" font-family="DejaVu Sans" font-size="34" font-weight="700">chat</text>
      <text x="245" y="555" fill="#aab3bf" font-family="DejaVu Sans" font-size="23">Ask about facts, risks, and next steps</text>
      <line x1="245" y1="610" x2="1655" y2="610" stroke="#273544" stroke-width="2"/>
      ${actionChip(245, 665, 425, "summarize-account")}
      ${actionChip(738, 665, 425, "triage-renewal-risk")}
      ${actionChip(1231, 665, 425, "build-weekly-review")}
      <text x="245" y="815" fill="#7f8997" font-family="DejaVu Sans" font-size="22">Direct actions use explicit inputs and return reviewable results.</text>
    `;
  }
  if (kind === "checks") {
    return `
      ${checkCard(180, 410, "1", "Run repeatable scenarios", "Use known inputs and expected behavior")}
      ${arrow(650, 625, 770, 625)}
      ${checkCard(775, 410, "2", "Compare active and candidate", "Review behavior, outputs, and regressions")}
      ${arrow(1245, 625, 1365, 625)}
      ${checkCard(1370, 410, "3", "Release after checks pass", "Keep the Profile on verified behavior")}
    `;
  }
  return `
    ${flowNode(140, 475, 340, "CREATE", "Purpose or chats", "#17212b")}
    ${arrow(500, 625, 560, 625)}
    ${flowNode(580, 475, 340, "CHECK", "Review the plan", "#10252d")}
    ${arrow(940, 625, 1000, 625)}
    ${flowNode(1020, 475, 340, "USE", "Chat or run", "#17212b")}
    ${arrow(1380, 625, 1440, 625)}
    ${flowNode(1460, 475, 340, "IMPROVE", "Use evidence", "#10252d")}
    <path d="M1630 825 C1630 955 310 955 310 845" fill="none" stroke="#67e8f9" stroke-width="3" stroke-dasharray="9 12"/>
    <polygon points="299,852 310,826 321,852" fill="#67e8f9"/>
  `;
}

function panel(x, y, width, height, heading, subheading, rows, fill) {
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="30" fill="${fill}" stroke="#2b3947" stroke-width="2"/>
    <text x="${x + 55}" y="${y + 80}" fill="#67e8f9" font-family="DejaVu Sans" font-size="25" font-weight="700" letter-spacing="2">${heading}</text>
    <text x="${x + 55}" y="${y + 140}" fill="#f7f7f8" font-family="DejaVu Sans" font-size="32" font-weight="700">${subheading}</text>
    ${rows.map((row, index) => `
      <circle cx="${x + 70}" cy="${y + 235 + (index * 78)}" r="7" fill="#67e8f9"/>
      <text x="${x + 100}" y="${y + 245 + (index * 78)}" fill="#c4cbd4" font-family="DejaVu Sans Mono" font-size="26">${row}</text>
    `).join("")}
  `;
}

function smallNode(x, y, width, height, heading, detail) {
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="#151e28" stroke="#2b3947" stroke-width="2"/>
    <text x="${x + 35}" y="${y + 62}" fill="#f7f7f8" font-family="DejaVu Sans" font-size="26" font-weight="700">${heading}</text>
    <text x="${x + 35}" y="${y + 108}" fill="#9da7b4" font-family="DejaVu Sans" font-size="21">${detail}</text>
  `;
}

function actionChip(x, y, width, label) {
  return `
    <rect x="${x}" y="${y}" width="${width}" height="82" rx="18" fill="#17232e" stroke="#314352" stroke-width="2"/>
    <circle cx="${x + 43}" cy="${y + 41}" r="12" fill="#67e8f9" opacity="0.9"/>
    <text x="${x + 72}" y="${y + 51}" fill="#f7f7f8" font-family="DejaVu Sans Mono" font-size="23">${label}</text>
  `;
}

function checkCard(x, y, number, heading, detail) {
  const detailLines = wrapSvgText(detail, 27);
  return `
    <rect x="${x}" y="${y}" width="420" height="430" rx="28" fill="#151e28" stroke="#2b3947" stroke-width="2"/>
    <circle cx="${x + 70}" cy="${y + 75}" r="34" fill="#102f39" stroke="#67e8f9" stroke-width="2"/>
    <text x="${x + 70}" y="${y + 87}" text-anchor="middle" fill="#67e8f9" font-family="DejaVu Sans" font-size="32" font-weight="700">${number}</text>
    <text x="${x + 45}" y="${y + 180}" fill="#f7f7f8" font-family="DejaVu Sans" font-size="28" font-weight="700">${heading}</text>
    <text x="${x + 45}" y="${y + 245}" fill="#9da7b4" font-family="DejaVu Sans" font-size="23">
      ${detailLines.map((line, index) => `<tspan x="${x + 45}" dy="${index === 0 ? 0 : 38}">${svgEscape(line)}</tspan>`).join("")}
    </text>
  `;
}

function flowNode(x, y, width, heading, detail, fill) {
  return `
    <rect x="${x}" y="${y}" width="${width}" height="300" rx="28" fill="${fill}" stroke="#2b3947" stroke-width="2"/>
    <text x="${x + (width / 2)}" y="${y + 125}" text-anchor="middle" fill="#67e8f9" font-family="DejaVu Sans" font-size="25" font-weight="700" letter-spacing="2">${heading}</text>
    <text x="${x + (width / 2)}" y="${y + 190}" text-anchor="middle" fill="#f7f7f8" font-family="DejaVu Sans" font-size="25">${detail}</text>
  `;
}

function arrow(x1, y1, x2, y2) {
  const head = x2 >= x1
    ? `${x2 - 19},${y2 - 11} ${x2},${y2} ${x2 - 19},${y2 + 11}`
    : `${x2 + 19},${y2 - 11} ${x2},${y2} ${x2 + 19},${y2 + 11}`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#67e8f9" stroke-width="3"/><polygon points="${head}" fill="#67e8f9"/>`;
}

function ffmpegArgs({ outputPath, timeline }) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const segment of timeline) {
    if (segment.inputType === "video") args.push("-i", segment.path);
    else args.push("-loop", "1", "-t", String(segment.duration), "-i", segment.path);
  }
  const narrated = timeline.filter((segment) => segment.kind === "slide");
  for (const segment of narrated) args.push("-i", segment.audioPath);

  const filters = timeline.map((segment, index) => {
    const base = `[${index}:v]fps=30,format=yuv420p,setsar=1`;
    if (segment.kind !== "slide") {
      return `${base},trim=duration=${segment.duration.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`;
    }
    return `${base},zoompan=z='min(zoom+0.00012,1.022)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=${segment.duration.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`;
  });
  let previous = "v0";
  for (let index = 1; index < timeline.length; index += 1) {
    const output = index === timeline.length - 1 ? "outv" : `x${index}`;
    filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${transitionDuration}:offset=${timeline[index].start.toFixed(3)}[${output}]`);
    previous = output;
  }
  const audioOffset = timeline.length;
  narrated.forEach((segment, index) => {
    const delayMs = Math.round((segment.start + transitionDuration + narrationConfig.leadInSeconds) * 1000);
    filters.push(`[${audioOffset + index}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}:all=1,volume=0.94[a${index}]`);
  });
  const duration = timeline.at(-1).end;
  filters.push(`${narrated.map((_, index) => `[a${index}]`).join("")}amix=inputs=${narrated.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[outa]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-metadata:s:a:0", `title=${narrationConfig.audioTitle}`,
    "-metadata:s:a:0", `handler_name=${narrationConfig.audioTitle}`,
    "-metadata:s:a:0", "language=eng",
    "-movflags", "+faststart", outputPath,
  );
  return args;
}

function renderVtt(timeline) {
  const cues = timeline.filter((segment) => segment.kind === "slide");
  return [
    "WEBVTT",
    "",
    ...cues.flatMap((cue) => {
      const start = cue.start + transitionDuration + narrationConfig.leadInSeconds;
      return [cue.id, `${vttTime(start)} --> ${vttTime(start + cue.audioDuration)}`, cue.narration, ""];
    }),
  ].join("\n");
}

async function probeVideo(videoPath) {
  return JSON.parse((await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=index,codec_name,codec_type,width,height,pix_fmt,r_frame_rate,sample_rate,channels:stream_tags=title,handler_name,language",
    "-of", "json", videoPath,
  ])).stdout);
}

function validateProbe(probe) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || video.codec_name !== "h264" || video.width !== 1920 || video.height !== 1080 || video.pix_fmt !== "yuv420p" || video.r_frame_rate !== "30/1") {
    throw new Error(`Unexpected Agent overview video stream: ${JSON.stringify(video)}`);
  }
  if (!audio || audio.codec_name !== "aac" || audio.sample_rate !== "48000" || audio.channels !== 2) {
    throw new Error(`Unexpected Agent overview audio stream: ${JSON.stringify(audio)}`);
  }
}

async function renderContactSheet(images) {
  await execFileAsync("gm", [
    "montage", "-background", "#101010", "-geometry", "480x270+10+10", "-tile", "4x",
    ...images, contactSheetPath,
  ]);
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

function wrapSvgText(value, maximumCharacters) {
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
  return lines;
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
