import { useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { AppDialog } from "../dialogs/AppDialog";
import { ArrowLeft, ArrowRight, Play, X } from "../icons";

export type LearningVideo = {
  captionsUrl?: string;
  description?: string;
  duration: string;
  eyebrow: string;
  id: string;
  posterUrl: string;
  script?: {
    fileName: string;
    url: string;
  };
  title: string;
  videoUrl: string;
};

export function LearningVideoCard({
  badge,
  onPlay,
  titleElement = "h3",
  video,
}: {
  badge?: string;
  onPlay?: () => void;
  titleElement?: "h1" | "h2" | "h3";
  video: LearningVideo;
}) {
  const [playerOpen, setPlayerOpen] = useState(false);
  const playerVideoRef = useRef<HTMLVideoElement>(null);
  const Title = titleElement;
  const titleId = `${video.id}-title`;

  function openPlayer() {
    if (onPlay) {
      onPlay();
      return;
    }
    flushSync(() => setPlayerOpen(true));
    const player = playerVideoRef.current;
    if (!player) return;
    player.load();
    void player.play().catch(() => undefined);
  }

  return (
    <>
      <article className="get-started-course-card" aria-labelledby={titleId}>
        <button
          aria-haspopup="dialog"
          aria-label={`Play ${video.title}`}
          className="get-started-course-open"
          onClick={openPlayer}
          type="button"
        />

        <div className="get-started-course-media">
          <img
            alt=""
            className="get-started-course-poster"
            decoding="async"
            src={video.posterUrl}
          />
          <span className="get-started-course-play-icon" aria-hidden="true">
            <Play fill="currentColor" size={19} />
          </span>
          {badge ? (
            <span className="get-started-course-badge" aria-hidden="true">
              {badge}
            </span>
          ) : null}
        </div>

        <div className="get-started-course-copy">
          <Title id={titleId}>{video.title}</Title>
          <div className="get-started-course-meta" aria-label={`${video.title} details`}>
            <span>{video.eyebrow}</span>
            <span aria-hidden="true">·</span>
            <span>{video.duration}</span>
          </div>
          {video.description ? <p>{video.description}</p> : null}
        </div>
      </article>

      {playerOpen && !onPlay ? (
        <LearningVideoPlayer
          onClose={() => setPlayerOpen(false)}
          video={video}
          videoRef={playerVideoRef}
        />
      ) : null}
    </>
  );
}

export function LearningVideoPlayer({
  autoAdvance = false,
  contained = false,
  inertExclusionSelector,
  navigation,
  onEnded,
  onClose,
  onPause,
  onTimeUpdate,
  video,
  videoRef,
}: {
  autoAdvance?: boolean;
  contained?: boolean;
  inertExclusionSelector?: string;
  navigation?: {
    currentIndex: number;
    onNext?: () => void;
    onPrevious?: () => void;
    total: number;
  };
  onEnded?: (video: HTMLVideoElement) => void;
  onClose: () => void;
  onPause?: (video: HTMLVideoElement) => void;
  onTimeUpdate?: (video: HTMLVideoElement) => void;
  video: LearningVideo;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  return (
    <AppDialog
      ariaLabel={`${video.title} player`}
      backdropClassName="get-started-course-player-backdrop"
      className="get-started-course-player"
      contained={contained}
      inertExclusionSelector={inertExclusionSelector}
      onClose={onClose}
    >
      <header className="get-started-course-player-header">
        <div className="get-started-course-player-copy">
          <strong>{video.title}</strong>
          <span>
            {navigation
              ? `Lesson ${navigation.currentIndex + 1} of ${navigation.total}`
              : video.eyebrow}
            {" · "}
            {video.duration}
          </span>
        </div>
        <div className="get-started-course-player-actions">
          {navigation ? (
            <>
              <button
                aria-label="Previous lesson"
                disabled={!navigation.onPrevious}
                onClick={navigation.onPrevious}
                title="Previous lesson"
                type="button"
              >
                <ArrowLeft size={17} />
              </button>
              <button
                aria-label="Next lesson"
                disabled={!navigation.onNext}
                onClick={navigation.onNext}
                title="Next lesson"
                type="button"
              >
                <ArrowRight size={17} />
              </button>
            </>
          ) : null}
          <button
            aria-label="Close video player"
            data-autofocus
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="get-started-course-player-body">
        <div className="get-started-course-player-media">
          <div className="get-started-course-player-stage">
            <video
              aria-label={`${video.title} video`}
              className="get-started-course-player-video"
              controls
              data-auto-advance={autoAdvance ? "true" : undefined}
              key={video.id}
              onEnded={(event) => onEnded?.(event.currentTarget)}
              onPause={(event) => onPause?.(event.currentTarget)}
              onTimeUpdate={(event) => onTimeUpdate?.(event.currentTarget)}
              playsInline
              poster={video.posterUrl}
              preload="metadata"
              ref={videoRef}
              src={video.videoUrl}
            >
              {video.captionsUrl ? (
                <track
                  kind="captions"
                  label="English"
                  src={video.captionsUrl}
                  srcLang="en"
                />
              ) : null}
            </video>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
