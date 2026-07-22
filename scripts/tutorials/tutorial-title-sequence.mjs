import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BACKGROUND = "#0d0f14";
const IDENTITY_PREFIXES = ["", "O", "Op", "Ope", "Open", "OpenP", "OpenPo", "OpenPon", "OpenPond"];
const IDENTITY_DURATIONS = [0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
const WALKTHROUGH_IDENTITY_HOLD_SECONDS = 0.7;
const WALKTHROUGH_TITLE_SECONDS = 2;

export async function renderTutorialTitlePoster({ outputPath, title, subtitle }) {
  await renderTutorialTitleFrame({ outputPath, stage: "full", subtitle, title });
}

export async function renderTutorialTitleOnlyPoster({ outputPath, title }) {
  await renderTutorialTitleFrame({ outputPath, stage: "title", title });
}

export async function renderTutorialTwoBeatIntro({ outputPath, posterPath, repoRoot }) {
  const identityPath = `${outputPath}.identity.mp4`;
  const identityDuration = IDENTITY_DURATIONS.reduce((total, duration) => total + duration, 0)
    + WALKTHROUGH_IDENTITY_HOLD_SECONDS;
  try {
    await renderTutorialIdentityReveal({
      completedHoldSeconds: WALKTHROUGH_IDENTITY_HOLD_SECONDS,
      outputPath: identityPath,
      repoRoot,
    });
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", identityPath,
      "-loop", "1", "-t", String(WALKTHROUGH_TITLE_SECONDS), "-i", posterPath,
      "-filter_complex",
      [
        `[0:v]fps=30,format=yuv420p,setsar=1,trim=duration=${identityDuration},setpts=PTS-STARTPTS[v0]`,
        `[1:v]fps=30,format=yuv420p,setsar=1,trim=duration=${WALKTHROUGH_TITLE_SECONDS},setpts=PTS-STARTPTS[v1]`,
        "[v0][v1]concat=n=2:v=1:a=0[outv]",
      ].join(";"),
      "-map", "[outv]", "-an",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", "30", "-t", "4", "-movflags", "+faststart",
      outputPath,
    ], { maxBuffer: 8 * 1024 * 1024 });
  } finally {
    await rm(identityPath, { force: true });
  }
}

export async function renderTutorialIntro({ outputPath, posterPath, repoRoot, title, subtitle }) {
  const blankPath = `${outputPath}.blank.png`;
  const identityPath = `${outputPath}.identity.mp4`;
  const titlePath = `${outputPath}.title.png`;
  try {
    await Promise.all([
      renderTutorialTitleFrame({ outputPath: blankPath, stage: "blank", subtitle, title }),
      renderTutorialIdentityReveal({ outputPath: identityPath, repoRoot }),
      renderTutorialTitleFrame({ outputPath: titlePath, stage: "title", subtitle, title }),
    ]);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-loop", "1", "-t", "0.5", "-i", blankPath,
      "-i", identityPath,
      "-loop", "1", "-t", "0.95", "-i", titlePath,
      "-loop", "1", "-t", "1.85", "-i", posterPath,
      "-filter_complex",
      [
        "[0:v]fps=30,format=yuv420p,setsar=1,trim=duration=0.5,setpts=PTS-STARTPTS[v0]",
        "[1:v]fps=30,format=yuv420p,setsar=1,trim=duration=1.3,setpts=PTS-STARTPTS[v1]",
        "[2:v]fps=30,format=yuv420p,setsar=1,trim=duration=0.95,setpts=PTS-STARTPTS[v2]",
        "[3:v]fps=30,format=yuv420p,setsar=1,trim=duration=1.85,setpts=PTS-STARTPTS[v3]",
        "[v0][v1]xfade=transition=fade:duration=0.2:offset=0.3[x1]",
        "[x1][v2]xfade=transition=fade:duration=0.2:offset=1.4[x2]",
        "[x2][v3]xfade=transition=fade:duration=0.2:offset=2.15[outv]",
      ].join(";"),
      "-map", "[outv]", "-an",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart",
      outputPath,
    ], { maxBuffer: 8 * 1024 * 1024 });
  } finally {
    await Promise.all([
      rm(blankPath, { force: true }),
      rm(identityPath, { force: true }),
      rm(titlePath, { force: true }),
    ]);
  }
}

export async function renderTutorialIdentityReveal({ completedHoldSeconds = 0, outputPath, repoRoot }) {
  const icon = path.join(repoRoot, "apps/web/public/openpond-icon.png");
  const resizedIcon = `${outputPath}.icon.png`;
  const identityDurations = IDENTITY_DURATIONS.map((duration, index) => (
    index === IDENTITY_DURATIONS.length - 1
      ? duration + completedHoldSeconds
      : duration
  ));
  const identityDuration = identityDurations.reduce((total, duration) => total + duration, 0);
  const stagePaths = IDENTITY_PREFIXES.map((_, index) => `${outputPath}.stage-${index}.png`);
  try {
    await execFileAsync("convert", [icon, "-resize", "104x104", resizedIcon]);
    await Promise.all(IDENTITY_PREFIXES.map(async (prefix, index) => {
      const basePath = `${stagePaths[index]}.base.png`;
      const textPath = `${stagePaths[index]}.text.png`;
      const groupBasePath = `${stagePaths[index]}.group-base.png`;
      const groupIconPath = `${stagePaths[index]}.group-icon.png`;
      const groupPath = `${stagePaths[index]}.group.png`;
      try {
        await execFileAsync("convert", ["-size", "1920x1080", `xc:${BACKGROUND}`, basePath]);
        if (!prefix) {
          await execFileAsync("composite", ["-gravity", "Center", resizedIcon, basePath, stagePaths[index]]);
          return;
        }
        await execFileAsync("convert", [
          "-background", "transparent",
          "-fill", "#f7f7f8",
          "-font", "DejaVu-Sans-Bold",
          "-pointsize", "72",
          `label:${prefix}`,
          textPath,
        ]);
        const [textWidth, textHeight] = (await execFileAsync("identify", [
          "-format", "%w %h",
          textPath,
        ])).stdout.trim().split(/\s+/).map(Number);
        const groupWidth = 100 + textWidth;
        await execFileAsync("convert", ["-size", `${groupWidth}x112`, "xc:none", groupBasePath]);
        await execFileAsync("composite", ["-geometry", "+0+4", resizedIcon, groupBasePath, groupIconPath]);
        await execFileAsync("composite", [
          "-geometry", `+100+${Math.max(0, Math.round((112 - textHeight) / 2))}`,
          textPath,
          groupIconPath,
          groupPath,
        ]);
        await execFileAsync("composite", ["-gravity", "Center", groupPath, basePath, stagePaths[index]]);
      } finally {
        await Promise.all([
          rm(basePath, { force: true }),
          rm(textPath, { force: true }),
          rm(groupBasePath, { force: true }),
          rm(groupIconPath, { force: true }),
          rm(groupPath, { force: true }),
        ]);
      }
    }));

    const filters = stagePaths.map((_, index) =>
      `[${index}:v]fps=30,format=yuv420p,setsar=1,trim=duration=${identityDurations[index]},setpts=PTS-STARTPTS[v${index}]`
    );
    filters.push(`${stagePaths.map((_, index) => `[v${index}]`).join("")}concat=n=${stagePaths.length}:v=1:a=0[identity]`);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      ...stagePaths.flatMap((stagePath, index) => [
        "-loop", "1", "-t", String(identityDurations[index]), "-i", stagePath,
      ]),
      "-filter_complex", filters.join(";"),
      "-map", "[identity]", "-an",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", "30", "-t", String(identityDuration),
      outputPath,
    ], { maxBuffer: 8 * 1024 * 1024 });
  } finally {
    await Promise.all([
      rm(resizedIcon, { force: true }),
      ...stagePaths.map((stagePath) => rm(stagePath, { force: true })),
    ]);
  }
}

async function renderTutorialTitleFrame({ outputPath, stage, title, subtitle }) {
  if (stage === "blank") {
    await execFileAsync("convert", ["-size", "1920x1080", `xc:${BACKGROUND}`, outputPath]);
    return;
  }
  const args = [
    "-size", "1920x1080", `xc:${BACKGROUND}`,
    "-gravity", "North",
    "-font", "DejaVu-Sans-Bold",
    "-fill", "#f7f7f8",
    "-stroke", "#f7f7f8",
    "-strokewidth", "2",
    "-pointsize", "80",
    "-draw", drawText(0, 380, title),
  ];
  if (stage === "full") {
    args.push(
      "-fill", "#67e8f9", "-draw", "rectangle 374,560 1546,564",
      "-fill", "#d1d5db", "-stroke", "none", "-font", "DejaVu-Sans",
      "-pointsize", "34", "-draw", drawText(0, 605, subtitle),
    );
  }
  args.push(outputPath);
  await execFileAsync("convert", args);
}

function drawText(x, y, value) {
  const escaped = String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `text ${x},${y} "${escaped}"`;
}
