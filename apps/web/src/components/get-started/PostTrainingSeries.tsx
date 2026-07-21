import { useEffect, useRef, type RefObject } from "react";
import { Play } from "../icons";
import { LearningVideoPlayer } from "./LearningVideoCard";
import {
  nextPostTrainingLessonIndex,
  POST_TRAINING_LESSONS,
  POST_TRAINING_SERIES_DURATION,
  POST_TRAINING_SERIES_TITLE,
} from "./post-training-lessons";
import { PostTrainingStatusPill } from "./PostTrainingStatusPill";
import {
  getPostTrainingProgress,
  postTrainingResumeTime,
  recordPostTrainingLessonProgress,
} from "./post-training-progress";

const SERIES_TITLE = POST_TRAINING_SERIES_TITLE;
const PLAYLIST_POSTER_INDEXES = [2, 1, 0] as const;

export function PostTrainingSeries({
  activeLessonIndex,
  autoplay = true,
  open,
  onClose,
  onOpen,
  onSelectLesson,
  playRequestId = 0,
}: {
  activeLessonIndex: number;
  autoplay?: boolean;
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  onSelectLesson: (index: number) => void;
  playRequestId?: number;
}) {
  const playerVideoRef = useRef<HTMLVideoElement>(null);
  const lastReportedProgressRef = useRef<{ lessonId: string; percent: number } | null>(null);
  const activeLesson = POST_TRAINING_LESSONS[activeLessonIndex]
    ?? POST_TRAINING_LESSONS[0]!;

  useEffect(() => {
    if (!open) return;
    const player = playerVideoRef.current;
    if (!player) return;
    let cancelled = false;
    lastReportedProgressRef.current = null;
    player.load();

    const preparePlayback = () => {
      if (cancelled) return;
      const resumeTime = postTrainingResumeTime(
        getPostTrainingProgress()[activeLesson.id],
      );
      if (resumeTime > 0) player.currentTime = resumeTime;
      if (playRequestId > 0) void player.play().catch(() => undefined);
    };
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) preparePlayback();
    else player.addEventListener("loadedmetadata", preparePlayback, { once: true });

    return () => {
      cancelled = true;
      player.removeEventListener("loadedmetadata", preparePlayback);
      if (Number.isFinite(player.duration) && player.duration > 0 && player.currentTime > 0) {
        recordPostTrainingLessonProgress({
          completed: player.ended,
          currentTime: player.currentTime,
          duration: player.duration,
          lessonId: activeLesson.id,
        });
      }
    };
  }, [activeLesson.id, open, playRequestId]);

  function recordProgress(player: HTMLVideoElement, completed = false) {
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;
    recordPostTrainingLessonProgress({
      completed,
      currentTime: completed ? player.duration : player.currentTime,
      duration: player.duration,
      lessonId: activeLesson.id,
    });
  }

  function handleTimeUpdate(player: HTMLVideoElement) {
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;
    const percent = Math.min(99, Math.floor((player.currentTime / player.duration) * 100));
    const previous = lastReportedProgressRef.current;
    if (previous?.lessonId === activeLesson.id && previous.percent === percent) return;
    lastReportedProgressRef.current = { lessonId: activeLesson.id, percent };
    recordProgress(player);
  }

  function handleEnded(player: HTMLVideoElement) {
    recordProgress(player, true);
    if (autoplay) advanceLesson();
  }

  function advanceLesson() {
    const nextIndex = nextPostTrainingLessonIndex(activeLessonIndex);
    if (nextIndex !== null) onSelectLesson(nextIndex);
  }

  return (
    <section className="get-started-series" aria-label={SERIES_TITLE}>
      <article className="get-started-playlist-card" aria-labelledby="post-training-series-title">
        <button
          aria-haspopup="dialog"
          aria-label={`Open ${SERIES_TITLE} playlist`}
          className="get-started-playlist-open"
          onClick={onOpen}
          type="button"
        />

        <div className="get-started-playlist-stack" aria-hidden="true">
          {PLAYLIST_POSTER_INDEXES.map((lessonIndex, stackIndex) => {
            const lesson = POST_TRAINING_LESSONS[lessonIndex]!;
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
            {POST_TRAINING_LESSONS.length} lessons
          </span>
        </div>

        <div className="get-started-playlist-copy">
          <div className="get-started-playlist-title">
            <h1 id="post-training-series-title">{SERIES_TITLE}</h1>
            <PostTrainingStatusPill />
          </div>
          <div className="get-started-course-meta">
            <span>Learning series</span>
            <span aria-hidden="true">·</span>
            <span>{POST_TRAINING_SERIES_DURATION}</span>
          </div>
          <p>Rewards, GRPO, RLVR, distillation, experiments, and a technical appendix.</p>
        </div>
      </article>

      {open ? (
        <PostTrainingCoursePlayer
          activeLessonIndex={activeLessonIndex}
          autoplay={autoplay}
          onClose={onClose}
          onEnded={handleEnded}
          onPause={recordProgress}
          onSelectLesson={onSelectLesson}
          onTimeUpdate={handleTimeUpdate}
          videoRef={playerVideoRef}
        />
      ) : null}
    </section>
  );
}

function PostTrainingCoursePlayer({
  activeLessonIndex,
  autoplay,
  onClose,
  onEnded,
  onPause,
  onSelectLesson,
  onTimeUpdate,
  videoRef,
}: {
  activeLessonIndex: number;
  autoplay: boolean;
  onClose: () => void;
  onEnded?: (video: HTMLVideoElement) => void;
  onPause?: (video: HTMLVideoElement) => void;
  onSelectLesson: (index: number) => void;
  onTimeUpdate?: (video: HTMLVideoElement) => void;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const activeLesson = POST_TRAINING_LESSONS[activeLessonIndex]
    ?? POST_TRAINING_LESSONS[0]!;
  const nextIndex = nextPostTrainingLessonIndex(activeLessonIndex);

  return (
    <LearningVideoPlayer
      autoAdvance={autoplay}
      contained
      inertExclusionSelector=".get-started-learning-panel"
      navigation={{
        currentIndex: activeLessonIndex,
        onNext: nextIndex !== null ? () => onSelectLesson(nextIndex) : undefined,
        onPrevious: activeLessonIndex > 0
          ? () => onSelectLesson(activeLessonIndex - 1)
          : undefined,
        total: POST_TRAINING_LESSONS.length,
      }}
      onClose={onClose}
      onEnded={onEnded}
      onPause={onPause}
      onTimeUpdate={onTimeUpdate}
      video={activeLesson}
      videoRef={videoRef}
    />
  );
}

export function PostTrainingSeriesPlayer({
  lessonIndex = 0,
  onClose,
}: {
  lessonIndex?: number;
  onClose: () => void;
}) {
  return (
    <PostTrainingCoursePlayer
      activeLessonIndex={lessonIndex}
      autoplay
      onClose={onClose}
      onEnded={() => undefined}
      onSelectLesson={() => undefined}
    />
  );
}
