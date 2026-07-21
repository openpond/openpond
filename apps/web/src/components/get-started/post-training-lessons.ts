import { publicAssetUrl } from "../../lib/public-assets";
import {
  publicVideoPlaylist,
  publicVideoUrl,
} from "../../lib/public-video-assets";
import type { LearningVideo } from "./LearningVideoCard";

export type PostTrainingLesson = LearningVideo & {
  lessonNumber: number;
  slug: string;
};

export type PostTrainingPanelView = "lessons" | "script";

export type PostTrainingCourseState = {
  autoplay: boolean;
  fullCourseSelected: boolean;
  lessonIndex: number;
  panelView: PostTrainingPanelView;
  playRequestId: number;
  scriptLessonIndex: number | null;
};

const POST_TRAINING_PLAYLIST = publicVideoPlaylist(
  "post-training-from-first-principles",
);

export const POST_TRAINING_SERIES_TITLE = POST_TRAINING_PLAYLIST.title;
export const POST_TRAINING_SERIES_STATUS = POST_TRAINING_PLAYLIST.status;

function lesson(
  lessonNumber: number,
  slug: string,
  title: string,
  eyebrow: string,
  duration: string,
  description: string,
): PostTrainingLesson {
  const assetRoot = `courses/post-training/${slug}`;
  const scriptFileName = `script_${String(lessonNumber).padStart(2, "0")}.md`;
  const id = `post-training-${slug}`;
  return {
    captionsUrl: publicAssetUrl(`${assetRoot}.vtt`),
    description,
    duration,
    eyebrow,
    id,
    lessonNumber,
    posterUrl: publicAssetUrl(`${assetRoot}-poster.webp`),
    script: {
      fileName: scriptFileName,
      url: publicAssetUrl(`courses/post-training/scripts/${scriptFileName}`),
    },
    slug,
    title,
    videoUrl: publicVideoUrl(id),
  };
}

export const POST_TRAINING_LESSONS: readonly PostTrainingLesson[] = [
  lesson(
    1,
    "01-how-post-training-works",
    "How post-training works",
    "Start here",
    "1:05",
    "The choose, judge, and update loop behind every method in this series.",
  ),
  lesson(
    2,
    "02-definitions",
    "Definitions",
    "Reference",
    "6:14",
    "Policy notation, softmax, rollouts, advantages, gradients, GRPO, and the acronyms used throughout the series.",
  ),
  lesson(
    3,
    "03-on-policy-off-policy",
    "On-policy and off-policy data",
    "Data source",
    "1:06",
    "Why learner rollouts and teacher or stored data support different updates.",
  ),
  lesson(
    4,
    "04-rewards-credit-assignment",
    "Rewards and credit assignment",
    "RL foundation",
    "3:00",
    "Follow a code-repair trajectory from actions and observations to advantage.",
  ),
  lesson(
    5,
    "05-verifiable-rewards-rlvr",
    "Verifiable rewards",
    "RLVR",
    "2:53",
    "See how tests create scalable rewards—and how a model can exploit the checker.",
  ),
  lesson(
    6,
    "06-ppo-grpo",
    "PPO and GRPO",
    "Policy updates",
    "2:54",
    "Compare PPO's learned critic with GRPO's sibling-response baseline.",
  ),
  lesson(
    7,
    "07-distillation",
    "Distillation",
    "Teacher targets",
    "2:42",
    "Transfer a teacher's token distribution instead of copying one final answer.",
  ),
  lesson(
    8,
    "08-opsd-sdft-sdpo",
    "OPSD, SDFT, and SDPO",
    "Teacher evidence",
    "2:43",
    "Compare trusted solutions, demonstrations, and failure feedback at one prefix.",
  ),
  lesson(
    9,
    "09-credible-experiments",
    "Credible experiments",
    "Research design",
    "3:32",
    "Build versioned datasets, fair baselines, and claims that survive scrutiny.",
  ),
  lesson(
    10,
    "10-technical-appendix",
    "Technical appendix",
    "Advanced details",
    "3:12",
    "Inspect GRPO normalization, compressed teacher logits, reported method results, and sample routing.",
  ),
] as const;

export const POST_TRAINING_SERIES_DURATION = "29 min";

const POST_TRAINING_FULL_VIDEO_ID = POST_TRAINING_PLAYLIST.fullVideoId;
if (!POST_TRAINING_FULL_VIDEO_ID) {
  throw new Error("Post-training playlist is missing its full video");
}

export const POST_TRAINING_FULL_COURSE: LearningVideo = {
  captionsUrl: publicAssetUrl("courses/post-training/full-course.vtt"),
  description: "All ten lessons in one continuous video for watching, sharing, or uploading.",
  duration: "29:20",
  eyebrow: "Full course",
  id: POST_TRAINING_FULL_VIDEO_ID,
  posterUrl: publicAssetUrl("courses/post-training/full-course-poster.webp"),
  title: POST_TRAINING_SERIES_TITLE,
  videoUrl: publicVideoUrl(POST_TRAINING_FULL_VIDEO_ID),
};

export function nextPostTrainingLessonIndex(currentIndex: number): number | null {
  const nextIndex = currentIndex + 1;
  return nextIndex < POST_TRAINING_LESSONS.length ? nextIndex : null;
}
