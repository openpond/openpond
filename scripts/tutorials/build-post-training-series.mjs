import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../..");
const courseRoot = join(
  repositoryRoot,
  "docs/research/post-training-course/manim",
);
const narrationRoot = join(courseRoot, "narration");
const sourceVideoRoot = join(courseRoot, "videos");
const courseOutputRoot = join(sourceVideoRoot, "lessons");
const publicOutputRoot = join(
  repositoryRoot,
  "apps/web/public/courses/post-training",
);
const coreManifest = JSON.parse(
  readFileSync(join(narrationRoot, "manifest.json"), "utf8"),
);
const appendixManifest = JSON.parse(
  readFileSync(join(narrationRoot, "appendix_manifest.json"), "utf8"),
);
const coreNarrationScript = readFileSync(
  join(courseRoot, "narration_script.md"),
  "utf8",
);
const appendixNarrationScript = readFileSync(
  join(courseRoot, "appendix_narration_script.md"),
  "utf8",
);

const lessons = [
  {
    chapterId: "Chapter01Policy",
    duration: "1:09",
    focus: "The choose, judge, and update loop behind every method in this series.",
    slug: "01-how-post-training-works",
    posterSecond: 43,
    title: "How post-training works",
  },
  {
    chapterId: "Chapter02Definitions",
    duration: "4:41",
    focus: "Decode the notation, objectives, estimators, and acronyms used throughout modern reinforcement fine-tuning.",
    slug: "02-definitions",
    posterSecond: 132,
    title: "Definitions",
  },
  {
    chapterId: "Chapter02OnOffPolicy",
    duration: "1:02",
    focus: "Why learner rollouts and teacher or stored data support different updates.",
    slug: "03-on-policy-off-policy",
    posterSecond: 17,
    title: "On-policy and off-policy data",
  },
  {
    chapterId: "Chapter03RLSignals",
    duration: "2:55",
    focus: "Follow a code-repair trajectory from actions and observations to advantage.",
    slug: "04-rewards-credit-assignment",
    posterSecond: 84,
    title: "Rewards and credit assignment",
  },
  {
    chapterId: "Chapter04RLVR",
    duration: "2:48",
    focus: "See how tests create scalable rewards—and how a model can exploit the checker.",
    slug: "05-verifiable-rewards-rlvr",
    posterSecond: 64,
    title: "Verifiable rewards",
  },
  {
    chapterId: "Chapter05GRPO",
    duration: "2:49",
    focus: "Compare PPO's learned critic with GRPO's sibling-response baseline.",
    slug: "06-ppo-grpo",
    posterSecond: 54,
    title: "PPO and GRPO",
  },
  {
    chapterId: "Chapter06Distillation",
    duration: "2:37",
    focus: "Transfer a teacher's token distribution instead of copying one final answer.",
    slug: "07-distillation",
    posterSecond: 48,
    title: "Distillation",
  },
  {
    chapterId: "Chapter07Methods",
    duration: "2:38",
    focus: "Compare trusted solutions, demonstrations, and failure feedback at one prefix.",
    slug: "08-opsd-sdft-sdpo",
    posterSecond: 72,
    title: "OPSD, SDFT, and SDPO",
  },
  {
    chapterId: "Chapter08Research",
    duration: "3:27",
    focus: "Build versioned datasets, fair baselines, and claims that survive scrutiny.",
    slug: "09-credible-experiments",
    posterSecond: 62,
    title: "Credible experiments",
  },
  {
    chapterIds: [
      "Appendix01GRPODetails",
      "Appendix02DistillationSystems",
      "Appendix03MethodStudies",
    ],
    duration: "3:07",
    expectedDurationSeconds: 187.067,
    focus: "Inspect implementation choices and paper-specific results after the core mechanisms are clear.",
    narrationScript: appendixNarrationScript,
    posterSecond: 139,
    preNarrated: true,
    slug: "10-technical-appendix",
    sourceManifest: appendixManifest,
    sourceVideoFile: "PostTrainingAdvancedAppendixNarrated.mp4",
    title: "Technical appendix",
    transcriptHeadings: [
      "GRPO details",
      "Distillation systems",
      "Paper details and SRPO",
    ],
    visualContext: "Length-normalization equations and pass-at-k curves; full versus top-k teacher-logit storage; paper-reported OPSD, SDFT, and SDPO bars; and an SRPO success/failure routing diagram.",
  },
];

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function durationSeconds(filePath) {
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

function extractVoiceover(chapterId, sourceScript = coreNarrationScript) {
  const start = `<!-- BEGIN VOICEOVER: ${chapterId} -->`;
  const end = "<!-- END VOICEOVER -->";
  const startIndex = sourceScript.indexOf(start);
  const endIndex = sourceScript.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing voiceover markers for ${chapterId}`);
  }
  return sourceScript
    .slice(startIndex + start.length, endIndex)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function extractVisualContext(chapterId) {
  const marker = `<!-- BEGIN VOICEOVER: ${chapterId} -->`;
  const markerIndex = coreNarrationScript.indexOf(marker);
  const chapterIndex = coreNarrationScript.lastIndexOf("## Chapter", markerIndex);
  if (chapterIndex < 0 || markerIndex < 0) {
    throw new Error(`Missing chapter context for ${chapterId}`);
  }
  const chapterIntroduction = coreNarrationScript.slice(chapterIndex, markerIndex);
  const visuals = chapterIntroduction.match(/^Visuals:\s*(.+)$/m)?.[1];
  if (!visuals) throw new Error(`Missing visual context for ${chapterId}`);
  return visuals;
}

function createLessonScript(lesson, outputPath) {
  const chapterIds = lesson.chapterIds ?? [lesson.chapterId];
  const sourceScript = lesson.narrationScript ?? coreNarrationScript;
  const visualContext = lesson.visualContext ?? extractVisualContext(lesson.chapterId);
  const transcript = chapterIds.map((chapterId, index) => {
    const voiceover = extractVoiceover(chapterId, sourceScript);
    const heading = lesson.transcriptHeadings?.[index];
    return heading ? `### ${heading}\n\n${voiceover}` : voiceover;
  }).join("\n\n");
  const content = `# ${lesson.title}

Post-training from first principles · Lesson ${lessons.indexOf(lesson) + 1} of ${lessons.length} · ${lesson.duration}

## Learning objective

${lesson.focus}

## Using this with an LLM

Use this script as lesson source material. Preserve its distinctions and caveats when summarizing, making flash cards, proposing experiments, or answering questions. The narration is the source of truth; ask for missing experimental details instead of inventing them.

## Visual context

${visualContext}

## Narration transcript

${transcript}

## Provenance

This is the production narration for the OpenPond learning series, generated from the canonical course script. Equations, diagrams, and cited paper results remain in the accompanying video and research document.
`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
}

function splitVoiceover(chapterId, sourceScript = coreNarrationScript) {
  const paragraphs = extractVoiceover(chapterId, sourceScript)
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

function speechFingerprint(input, sourceManifest = coreManifest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: sourceManifest.model,
        voice: sourceManifest.voice,
        speed: sourceManifest.speed,
        instructions: sourceManifest.instructions,
        input,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

function rawSpeechPath(chapterId, beat, index, sourceManifest = coreManifest) {
  return join(
    narrationRoot,
    "raw/segments",
    chapterId,
    `${String(index + 1).padStart(3, "0")}-${speechFingerprint(beat, sourceManifest)}.wav`,
  );
}

function vttTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainingMilliseconds = milliseconds % 1000;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    `${String(remainingSeconds).padStart(2, "0")}.${String(remainingMilliseconds).padStart(3, "0")}`,
  ].join(":");
}

function createCaptions(
  chapters,
  outputPath,
  sourceScript = coreNarrationScript,
  sourceManifest = coreManifest,
) {
  const cues = [];
  let chapterOffset = 0;
  let cueNumber = 1;
  for (const chapter of chapters) {
    const beats = splitVoiceover(chapter.id, sourceScript);
    const speech = beats.map((beat, index) => {
      const filePath = rawSpeechPath(chapter.id, beat, index, sourceManifest);
      if (!existsSync(filePath)) {
        throw new Error(`Missing source narration segment: ${filePath}`);
      }
      return { beat, duration: durationSeconds(filePath) };
    });
    const speechSeconds = speech.reduce((sum, item) => sum + item.duration, 0);
    const breakCount = Math.max(0, speech.length - 1);
    const breakSeconds = breakCount > 0
      ? (
        chapter.durationSeconds
        - sourceManifest.leadInSeconds
        - sourceManifest.tailSeconds
        - speechSeconds
      ) / breakCount
      : 0;
    if (breakSeconds < 0) {
      throw new Error(`${chapter.id} narration exceeds its fitted window`);
    }

    let cursor = chapterOffset + sourceManifest.leadInSeconds;
    for (const [index, item] of speech.entries()) {
      const start = cursor;
      const chapterEnd = chapterOffset + chapter.durationSeconds;
      const end = Math.min(chapterEnd, start + item.duration);
      cursor = end + (index < speech.length - 1 ? breakSeconds : 0);
      cues.push(`${cueNumber}\n${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${item.beat}`);
      cueNumber += 1;
    }
    chapterOffset += chapter.durationSeconds;
  }
  writeFileSync(outputPath, `WEBVTT\n\n${cues.join("\n\n")}\n`);
}

rmSync(courseOutputRoot, { force: true, recursive: true });
rmSync(publicOutputRoot, { force: true, recursive: true });
mkdirSync(courseOutputRoot, { recursive: true });
mkdirSync(publicOutputRoot, { recursive: true });

for (const [lessonIndex, lesson] of lessons.entries()) {
  const sourceManifest = lesson.sourceManifest ?? coreManifest;
  const sourceScript = lesson.narrationScript ?? coreNarrationScript;
  const chapterIds = lesson.chapterIds ?? [lesson.chapterId];
  const chapters = chapterIds.map((chapterId) => {
    const chapter = sourceManifest.chapters.find(({ id }) => id === chapterId);
    if (!chapter) throw new Error(`Unknown chapter: ${chapterId}`);
    return chapter;
  });

  const sourceVideo = join(
    sourceVideoRoot,
    lesson.sourceVideoFile ?? `${lesson.chapterId}.mp4`,
  );
  const sourceAudio = lesson.preNarrated
    ? null
    : join(narrationRoot, "fitted", `${lesson.chapterId}.wav`);
  const courseVideo = join(courseOutputRoot, `${lesson.slug}.mp4`);
  const coursePoster = join(courseOutputRoot, `${lesson.slug}-poster.webp`);
  const courseCaptions = join(courseOutputRoot, `${lesson.slug}.vtt`);
  const scriptFileName = `script_${String(lessonIndex + 1).padStart(2, "0")}.md`;
  const courseScript = join(courseOutputRoot, "scripts", scriptFileName);

  for (const input of [sourceVideo, sourceAudio].filter(Boolean)) {
    if (!existsSync(input)) throw new Error(`Missing input: ${input}`);
  }

  if (lesson.preNarrated) {
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourceVideo,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-metadata:s:a:0",
      "title=AI-generated narration",
      "-metadata:s:a:0",
      "handler_name=AI-generated narration",
      "-metadata:s:a:0",
      "language=eng",
      "-movflags",
      "+faststart",
      courseVideo,
    ]);
  } else {
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourceVideo,
      "-i",
      sourceAudio,
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
      courseVideo,
    ]);
  }

  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(lesson.posterSecond),
    "-i",
    sourceVideo,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    "-c:v",
    "libwebp",
    "-quality",
    "82",
    coursePoster,
  ]);

  createCaptions(chapters, courseCaptions, sourceScript, sourceManifest);
  createLessonScript(lesson, courseScript);

  for (const courseFile of [courseVideo, coursePoster, courseCaptions]) {
    copyFileSync(courseFile, join(publicOutputRoot, basename(courseFile)));
  }
  const publicScript = join(publicOutputRoot, "scripts", scriptFileName);
  mkdirSync(dirname(publicScript), { recursive: true });
  copyFileSync(courseScript, publicScript);

  const mediaDuration = durationSeconds(courseVideo);
  const expectedDurationSeconds = lesson.expectedDurationSeconds
    ?? chapters.reduce((total, chapter) => total + chapter.durationSeconds, 0);
  if (Math.abs(mediaDuration - expectedDurationSeconds) > 0.15) {
    throw new Error(
      `${lesson.title} duration mismatch: ${mediaDuration.toFixed(3)}s`,
    );
  }
  if (statSync(courseVideo).size > 15 * 1024 * 1024) {
    throw new Error(`${lesson.title} exceeds the 15 MB lesson budget`);
  }
  console.log(
    `${lesson.title}: ${mediaDuration.toFixed(3)}s -> ${courseVideo}`,
  );
}

console.log(`Created ${lessons.length} narrated lessons in ${courseOutputRoot}`);
console.log(`Copied web assets to ${publicOutputRoot}`);
run(process.execPath, [join(scriptDir, "prepare-public-videos.mjs")]);
