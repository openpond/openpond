import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(
  path.join(root, "apps/web/src/components/get-started/how-to-make-an-agent.frames.json"),
  "utf8",
)) as {
  frames: Array<{
    id: string;
    chapter: string;
    caption: string;
    file: string;
    narration: string;
    focus: { x: number; y: number; width: number; height: number; zoom: number };
  }>;
};
const builder = readFileSync(
  path.join(root, "scripts/tutorials/build-how-to-make-an-agent.mjs"),
  "utf8",
);
const agentOverviewBuilder = readFileSync(
  path.join(root, "scripts/tutorials/build-openpond-agent-overview.mjs"),
  "utf8",
);
const tutorialTitleSequence = readFileSync(
  path.join(root, "scripts/tutorials/tutorial-title-sequence.mjs"),
  "utf8",
);
const postTrainingSeriesBuilder = readFileSync(
  path.join(root, "scripts/tutorials/build-post-training-series.mjs"),
  "utf8",
);
const publicMediaVerifier = readFileSync(
  path.join(root, "scripts/tutorials/verify-public-media.mjs"),
  "utf8",
);
const publicVideoPreparer = readFileSync(
  path.join(root, "scripts/tutorials/prepare-public-videos.mjs"),
  "utf8",
);
const publicMediaPuller = readFileSync(
  path.join(root, "scripts/tutorials/pull-public-videos.mjs"),
  "utf8",
);
const webViteConfig = readFileSync(
  path.join(root, "apps/web/vite.config.ts"),
  "utf8",
);

describe("How to make an agent media contract", () => {
  test("contains every acceptance frame exactly once in chapter order", () => {
    const expected = [
      "C01", "C02", "C04", "C06", "C07", "C08", "C09", "C09A", "C09B", "C10", "C11", "C12",
      "C13Q", "C13", "C14", "C15", "C16", "C17", "C18", "C19",
      "I00", "I01", "I02", "I03", "I04", "I05", "I06", "I07", "I08", "I09", "I10", "I11",
    ];

    expect(manifest.frames.map((frame) => frame.id)).toEqual(expected);
    expect(new Set(manifest.frames.map((frame) => frame.file)).size).toBe(expected.length);
    expect(manifest.frames.every((frame) => frame.caption.length > 20)).toBe(true);
    expect(manifest.frames.every((frame) => frame.narration === frame.caption)).toBe(true);
    expect(manifest.frames.every((frame) => frame.narration.split(/(?<=[.!?])\s+/).length <= 2)).toBe(true);
    expect(manifest.frames.every((frame) =>
      frame.focus.x >= 0
      && frame.focus.y >= 0
      && frame.focus.width > 0
      && frame.focus.height > 0
      && frame.focus.x + frame.focus.width <= 1
      && frame.focus.y + frame.focus.height <= 1
      && frame.focus.zoom >= 1
      && frame.focus.zoom <= 2
    )).toBe(true);
    expect(manifest.frames.filter((frame) => frame.chapter === "create")).toHaveLength(12);
    expect(manifest.frames.filter((frame) => frame.chapter === "use")).toHaveLength(8);
    expect(manifest.frames.filter((frame) => frame.chapter === "improve")).toHaveLength(12);
  });

  test("refuses failed reports and encodes the checked playback format", () => {
    expect(builder).toContain("Refusing to build from a failed Account Health scenario report");
    expect(builder).toContain('"-c:v", "libx264"');
    expect(builder).toContain('"-pix_fmt", "yuv420p"');
    expect(builder).toContain('"-movflags", "+faststart"');
    expect(builder).toContain('"-c:a", "aac"');
    expect(builder).toContain("prepareTutorialNarration");
    expect(builder).toContain("zoompan=z=");
    expect(builder).toContain("Expected one narrated audio stream");
    expect(builder).not.toContain("`${frame.id}  ·  ${frame.label}`");
    expect(builder).not.toContain("`${cue.id} · ${cue.caption}`");
    expect(builder).toContain("25 * 1024 * 1024");
    expect(builder).toContain("tutorial-contact-sheet.png");
    expect(builder).toContain("visualQaStatus");
    expect(builder).toContain("manifest.frames.length > 0");
    expect(builder).toContain("screenshotByName.size >= manifest.frames.length");
    expect(builder).toContain('schemaVersion: "openpond.tutorialBuild.v3"');
    expect(builder).toContain('id: "play-all"');
    expect(builder).toContain('kind: "lesson"');
    expect(builder).toContain('slug: `how-to-make-an-agent-${chapter.id}`');
    expect(builder).toContain("contactSheets");
    expect(builder).toContain("variants: results.map");
    expect(builder).toContain("renderTutorialTwoBeatIntro");
    expect(builder).toContain("renderTutorialTitleOnlyPoster");
    expect(builder).not.toContain("renderTutorialIntro");
    expect(builder).toContain("chapterIndex > 0");
    expect(builder).not.toContain("drawText(0, 365, tutorialTitle)");
    expect(tutorialTitleSequence).toContain("renderTutorialIdentityReveal");
    expect(tutorialTitleSequence).toContain("WALKTHROUGH_IDENTITY_HOLD_SECONDS");
    expect(tutorialTitleSequence).toContain('"[v0][v1]concat=n=2:v=1:a=0[outv]"');
    expect(tutorialTitleSequence).toContain("IDENTITY_PREFIXES");
    expect(tutorialTitleSequence).toContain("IDENTITY_DURATIONS");
    expect(tutorialTitleSequence).not.toContain('identityOnly ? "+635+484" : "+795+190"');
    expect(builder).toContain('platform: "X / Twitter"');
    expect(builder).toContain("openpond-how-to-make-an-agent-full.mp4");
    expect(builder).toContain("The full-length social export does not match the checked Play all video");
  });

  test("builds a captioned Start here overview with a single identity beat", () => {
    expect(agentOverviewBuilder).toContain('const title = "What is an OpenPond Agent?"');
    expect(agentOverviewBuilder).toContain('id: "overview-profile"');
    expect(agentOverviewBuilder).toContain('id: "overview-entrypoints"');
    expect(agentOverviewBuilder).toContain('id: "overview-surfaces"');
    expect(agentOverviewBuilder).toContain('id: "overview-example"');
    expect(agentOverviewBuilder).toContain('id: "overview-checks"');
    expect(agentOverviewBuilder).toContain('id: "overview-lifecycle"');
    expect(agentOverviewBuilder).toContain("renderTutorialIntro");
    expect(tutorialTitleSequence).toContain('stage: "title"');
    expect(agentOverviewBuilder).toContain("prepareTutorialNarration");
    expect(agentOverviewBuilder).toContain('"-movflags", "+faststart"');
    expect(agentOverviewBuilder).toContain('visualQaStatus: "pending"');
  });
});

describe("Post-training learning series media contract", () => {
  test("packages every core chapter and the narrated appendix as fast-start, captioned lessons", () => {
    expect(postTrainingSeriesBuilder.match(/chapterId: "Chapter\d\d\w+"/g)).toHaveLength(9);
    expect(postTrainingSeriesBuilder).toContain("PostTrainingAdvancedAppendixNarrated.mp4");
    expect(postTrainingSeriesBuilder).toContain('slug: "10-technical-appendix"');
    expect(postTrainingSeriesBuilder).toContain('"full-course.mp4"');
    expect(postTrainingSeriesBuilder).toContain("createFullCourseCaptions");
    expect(postTrainingSeriesBuilder).toContain("appendix_manifest.json");
    expect(postTrainingSeriesBuilder).toContain('"-movflags"');
    expect(postTrainingSeriesBuilder).toContain('"+faststart"');
    expect(postTrainingSeriesBuilder).toContain("AI-generated narration");
    expect(postTrainingSeriesBuilder).toContain("createCaptions(chapters, courseCaptions");
    expect(postTrainingSeriesBuilder).toContain("createLessonScript(lesson, courseScript)");
    expect(postTrainingSeriesBuilder).toContain("15 * 1024 * 1024");
  });

  test("ships a standalone LLM-ready Markdown script for every lesson", () => {
    for (let lessonNumber = 1; lessonNumber <= 10; lessonNumber += 1) {
      const fileName = `script_${String(lessonNumber).padStart(2, "0")}.md`;
      const script = readFileSync(
        path.join(root, "apps/web/public/courses/post-training/scripts", fileName),
        "utf8",
      );
      expect(script).toContain("## Learning objective");
      expect(script).toContain("## Using this with an LLM");
      expect(script).toContain("## Visual context");
      expect(script).toContain("## Narration transcript");
      expect(script.length).toBeGreaterThan(500);
    }
    const appendixScript = readFileSync(
      path.join(root, "apps/web/public/courses/post-training/scripts/script_10.md"),
      "utf8",
    );
    expect(appendixScript).toContain("### GRPO details");
    expect(appendixScript).toContain("### Distillation systems");
    expect(appendixScript).toContain("### Paper details and SRPO");
  });

  test("publishes only manifest-tracked MP4s and gates production playback", () => {
    expect(publicVideoPreparer).toContain('status: "draft"');
    expect(publicVideoPreparer).toContain('id: "post-training-from-first-principles"');
    expect(publicVideoPreparer).toContain('id: "post-training-full-course"');
    expect(publicVideoPreparer).toContain("fullVideoId: fullCourseVideo.id");
    expect(publicVideoPreparer).toContain('id: "how-to-make-an-agent"');
    expect(publicVideoPreparer).toContain('id: "openpond-agent-overview"');
    expect(publicVideoPreparer).toContain('playAllVideoId: "make-agent-tutorial"');
    expect(publicMediaVerifier).toContain('Range: "bytes=0-0"');
    expect(publicMediaVerifier).toContain('"access-control-allow-origin"');
    expect(publicMediaVerifier).toContain('includes("immutable")');
    expect(publicMediaVerifier).toContain("content-range");
    expect(publicMediaVerifier).toContain("public-video-manifest.json");
    expect(publicMediaVerifier).toContain("media/videos/");
    expect(publicMediaVerifier).not.toContain("-poster.webp");
    expect(publicMediaVerifier).not.toContain(".vtt\"");
    expect(publicMediaPuller).toContain("public-video-manifest.json");
    expect(publicMediaPuller).toContain("Downloaded video failed its manifest checksum");
    expect(webViteConfig).toContain("excludeLocalVideosFromProduction");
    expect(webViteConfig).toContain("rmSync(resolve(outputRoot, video.localPath)");
  });
});
