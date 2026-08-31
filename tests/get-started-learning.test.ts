import { describe, expect, test } from "vitest";

import {
  MAKE_AGENT_TUTORIAL_LESSONS,
  MAKE_AGENT_TUTORIAL_VIDEOS,
} from "../apps/web/src/components/get-started/make-agent-tutorial";
import {
  nextPostTrainingLessonIndex,
  POST_TRAINING_LESSONS,
} from "../apps/web/src/components/get-started/post-training-lessons";
import {
  normalizePostTrainingProgress,
  parsePostTrainingProgress,
  postTrainingProgressPercent,
  postTrainingResumeTime,
  startingPostTrainingLessonIndex,
} from "../apps/web/src/components/get-started/post-training-progress";

describe("Get Started learning data", () => {
  test("keeps the learning series ordered and individually loadable", () => {
    expect(POST_TRAINING_LESSONS.map((lesson) => lesson.lessonNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(POST_TRAINING_LESSONS.every((lesson) => lesson.videoUrl.endsWith(".mp4"))).toBe(true);
    expect(POST_TRAINING_LESSONS.every((lesson) => lesson.captionsUrl?.endsWith(".vtt"))).toBe(true);
    expect(nextPostTrainingLessonIndex(0)).toBe(1);
    expect(nextPostTrainingLessonIndex(9)).toBeNull();
  });

  test("normalizes, reports, resumes, and sequences persistent lesson progress", () => {
    const progress = normalizePostTrainingProgress({
      [POST_TRAINING_LESSONS[0]!.id]: {
        completed: true,
        currentTime: 40,
        duration: 69,
        updatedAt: 10,
      },
      [POST_TRAINING_LESSONS[1]!.id]: {
        completed: false,
        currentTime: 31,
        duration: 62,
        updatedAt: 20,
      },
      invalid: { currentTime: "nope", duration: 0 },
    });

    expect(progress.invalid).toBeUndefined();
    expect(postTrainingProgressPercent(progress[POST_TRAINING_LESSONS[0]!.id])).toBe(100);
    expect(postTrainingProgressPercent(progress[POST_TRAINING_LESSONS[1]!.id])).toBe(50);
    expect(postTrainingResumeTime(progress[POST_TRAINING_LESSONS[1]!.id])).toBe(31);
    expect(postTrainingResumeTime(progress[POST_TRAINING_LESSONS[0]!.id])).toBe(0);
    expect(startingPostTrainingLessonIndex(
      progress,
      POST_TRAINING_LESSONS.map((lesson) => lesson.id),
    )).toBe(1);
    expect(parsePostTrainingProgress("not-json")).toEqual({});
  });

  test("keeps the Agent tutorial catalog ordered", () => {
    expect(MAKE_AGENT_TUTORIAL_LESSONS.map((lesson) => lesson.title)).toEqual([
      "Create an Agent",
      "Use the Agent",
      "Improve the Agent",
    ]);
    expect(MAKE_AGENT_TUTORIAL_VIDEOS.map((video) => video.videoId)).toEqual([
      "play-all",
      "create",
      "use",
      "improve",
    ]);
  });
});
