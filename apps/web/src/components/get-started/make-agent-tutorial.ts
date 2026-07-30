import {
  MAKE_AGENT_TUTORIAL_CAPTIONS_URL,
  MAKE_AGENT_TUTORIAL_POSTER_URL,
  makeAgentTutorialCaptionsUrl,
  makeAgentTutorialPosterUrl,
} from "../../lib/public-assets";
import {
  MAKE_AGENT_TUTORIAL_VIDEO_URL,
  makeAgentTutorialVideoUrl,
  publicVideoPlaylist,
} from "../../lib/public-video-assets";
import framesManifest from "./how-to-make-an-agent.frames.json";
import type { LearningVideo } from "./LearningVideoCard";

export type MakeAgentTutorialChapterId = "create" | "use" | "improve";
export type MakeAgentTutorialVideoId = "play-all" | MakeAgentTutorialChapterId;

export type MakeAgentTutorialState = {
  autoplay: boolean;
  playRequestId: number;
  videoId: MakeAgentTutorialVideoId;
};

export type MakeAgentTutorialVideo = LearningVideo & {
  chapterIds: readonly MakeAgentTutorialChapterId[];
  lessonNumber: number | null;
  videoId: MakeAgentTutorialVideoId;
};

type ChapterManifest = {
  id: MakeAgentTutorialChapterId;
  label: string;
  title: string;
  subtitle: string;
};

const PLAYLIST = publicVideoPlaylist("how-to-make-an-agent");
const CHAPTERS = framesManifest.chapters as ChapterManifest[];
const LESSON_DURATIONS: Record<MakeAgentTutorialChapterId, string> = {
  create: "1:24",
  use: "1:05",
  improve: "1:10",
};

export const MAKE_AGENT_PLAYLIST_TITLE = PLAYLIST.title;
export const MAKE_AGENT_TUTORIAL_TITLE = framesManifest.tutorial.title;
export const MAKE_AGENT_TUTORIAL_DURATION = "4:33";

export const MAKE_AGENT_TUTORIAL_PLAY_ALL: MakeAgentTutorialVideo = {
  captionsUrl: MAKE_AGENT_TUTORIAL_CAPTIONS_URL,
  chapterIds: CHAPTERS.map((chapter) => chapter.id),
  description: "Create, use, and improve an Account Health Agent in one continuous walkthrough.",
  duration: MAKE_AGENT_TUTORIAL_DURATION,
  eyebrow: "Play all",
  id: "make-agent-tutorial",
  lessonNumber: null,
  posterUrl: MAKE_AGENT_TUTORIAL_POSTER_URL,
  title: MAKE_AGENT_TUTORIAL_TITLE,
  videoId: "play-all",
  videoUrl: MAKE_AGENT_TUTORIAL_VIDEO_URL,
};

export const MAKE_AGENT_TUTORIAL_LESSONS: readonly MakeAgentTutorialVideo[] = CHAPTERS.map(
  (chapter, index) => ({
    captionsUrl: makeAgentTutorialCaptionsUrl(chapter.id),
    chapterIds: [chapter.id],
    description: chapter.subtitle,
    duration: LESSON_DURATIONS[chapter.id],
    eyebrow: `Lesson ${index + 1}`,
    id: `make-agent-tutorial-${chapter.id}`,
    lessonNumber: index + 1,
    posterUrl: makeAgentTutorialPosterUrl(chapter.id),
    title: chapter.title,
    videoId: chapter.id,
    videoUrl: makeAgentTutorialVideoUrl(chapter.id),
  }),
);

export const MAKE_AGENT_TUTORIAL_VIDEOS: readonly MakeAgentTutorialVideo[] = [
  MAKE_AGENT_TUTORIAL_PLAY_ALL,
  ...MAKE_AGENT_TUTORIAL_LESSONS,
];

export const MAKE_AGENT_TUTORIAL = MAKE_AGENT_TUTORIAL_PLAY_ALL;

export function makeAgentTutorialVideo(videoId: MakeAgentTutorialVideoId): MakeAgentTutorialVideo {
  return MAKE_AGENT_TUTORIAL_VIDEOS.find((video) => video.videoId === videoId)
    ?? MAKE_AGENT_TUTORIAL_PLAY_ALL;
}

export function nextMakeAgentTutorialLessonId(
  videoId: MakeAgentTutorialVideoId,
): MakeAgentTutorialChapterId | null {
  const index = MAKE_AGENT_TUTORIAL_LESSONS.findIndex((lesson) => lesson.videoId === videoId);
  if (index < 0) return null;
  return MAKE_AGENT_TUTORIAL_LESSONS[index + 1]?.videoId as MakeAgentTutorialChapterId | undefined
    ?? null;
}
