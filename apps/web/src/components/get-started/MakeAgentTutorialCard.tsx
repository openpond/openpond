import { useEffect, useRef, type RefObject } from "react";
import { Play } from "../icons";
import { LearningVideoPlayer } from "./LearningVideoCard";
import {
  MAKE_AGENT_TUTORIAL_DURATION,
  MAKE_AGENT_TUTORIAL_LESSONS,
  MAKE_AGENT_PLAYLIST_TITLE,
  makeAgentTutorialVideo,
  nextMakeAgentTutorialLessonId,
  type MakeAgentTutorialChapterId,
  type MakeAgentTutorialVideoId,
} from "./make-agent-tutorial";

const PLAYLIST_POSTER_INDEXES = [2, 1, 0] as const;

export function MakeAgentTutorialCard({
  activeVideoId = "play-all",
  autoplay = true,
  onClose,
  onOpen,
  onSelectVideo,
  open = false,
  playRequestId = 0,
}: {
  activeVideoId?: MakeAgentTutorialVideoId;
  autoplay?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
  onSelectVideo?: (videoId: MakeAgentTutorialVideoId) => void;
  open?: boolean;
  playRequestId?: number;
} = {}) {
  const playerVideoRef = useRef<HTMLVideoElement>(null);
  const activeVideo = makeAgentTutorialVideo(activeVideoId);

  useEffect(() => {
    if (!open) return;
    const player = playerVideoRef.current;
    if (!player) return;
    player.load();
    if (playRequestId > 0) void player.play().catch(() => undefined);
  }, [activeVideo.id, open, playRequestId]);

  function handleEnded() {
    if (!autoplay || !onSelectVideo) return;
    const nextVideoId = nextMakeAgentTutorialLessonId(activeVideoId);
    if (nextVideoId) onSelectVideo(nextVideoId);
  }

  return (
    <section className="get-started-series" aria-label={MAKE_AGENT_PLAYLIST_TITLE}>
      <article className="get-started-playlist-card" aria-labelledby="make-agent-series-title">
        <button
          aria-haspopup="dialog"
          aria-label={`Open ${MAKE_AGENT_PLAYLIST_TITLE} playlist`}
          className="get-started-playlist-open"
          onClick={onOpen}
          type="button"
        />

        <div className="get-started-playlist-stack" aria-hidden="true">
          {PLAYLIST_POSTER_INDEXES.map((lessonIndex, stackIndex) => {
            const lesson = MAKE_AGENT_TUTORIAL_LESSONS[lessonIndex]!;
            return (
              <div
                className={`get-started-playlist-poster layer-${stackIndex + 1}`}
                key={lesson.id}
              >
                <img alt="" decoding="async" src={lesson.posterUrl} />
              </div>
            );
          })}
          <span className="get-started-course-play-icon">
            <Play fill="currentColor" size={19} />
          </span>
          <span className="get-started-playlist-count">
            {MAKE_AGENT_TUTORIAL_LESSONS.length} lessons
          </span>
        </div>

        <div className="get-started-playlist-copy">
          <h1 id="make-agent-series-title">{MAKE_AGENT_PLAYLIST_TITLE}</h1>
          <div className="get-started-course-meta">
            <span>Walkthrough playlist</span>
            <span aria-hidden="true">·</span>
            <span>{MAKE_AGENT_TUTORIAL_DURATION}</span>
          </div>
          <p>Create, use, and improve an Account Health Agent, or play the full walkthrough.</p>
        </div>
      </article>

      {open && onClose && onSelectVideo ? (
        <MakeAgentTutorialPlayer
          activeVideoId={activeVideoId}
          autoplay={autoplay}
          contained
          inertExclusionSelector=".get-started-learning-panel"
          onClose={onClose}
          onEnded={handleEnded}
          onSelectVideo={onSelectVideo}
          videoRef={playerVideoRef}
        />
      ) : null}
    </section>
  );
}

export function MakeAgentTutorialPlayer({
  activeVideoId = "play-all",
  autoplay = true,
  contained = false,
  inertExclusionSelector,
  onClose,
  onEnded,
  onSelectVideo = () => undefined,
  videoRef,
}: {
  activeVideoId?: MakeAgentTutorialVideoId;
  autoplay?: boolean;
  contained?: boolean;
  inertExclusionSelector?: string;
  onClose: () => void;
  onEnded?: () => void;
  onSelectVideo?: (videoId: MakeAgentTutorialVideoId) => void;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const video = makeAgentTutorialVideo(activeVideoId);
  const lessonIndex = MAKE_AGENT_TUTORIAL_LESSONS.findIndex(
    (lesson) => lesson.videoId === activeVideoId,
  );
  const next = lessonIndex >= 0
    ? MAKE_AGENT_TUTORIAL_LESSONS[lessonIndex + 1]?.videoId as MakeAgentTutorialChapterId | undefined
    : undefined;
  const previous = lessonIndex > 0
    ? MAKE_AGENT_TUTORIAL_LESSONS[lessonIndex - 1]?.videoId as MakeAgentTutorialChapterId | undefined
    : undefined;

  return (
    <LearningVideoPlayer
      autoAdvance={autoplay && lessonIndex >= 0}
      contained={contained}
      inertExclusionSelector={inertExclusionSelector}
      navigation={lessonIndex >= 0 ? {
        currentIndex: lessonIndex,
        onNext: next ? () => onSelectVideo(next) : undefined,
        onPrevious: previous ? () => onSelectVideo(previous) : undefined,
        total: MAKE_AGENT_TUTORIAL_LESSONS.length,
      } : undefined}
      onClose={onClose}
      onEnded={onEnded ? () => onEnded() : undefined}
      video={video}
      videoRef={videoRef}
    />
  );
}
