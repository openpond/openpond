import { useEffect, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Pause, Play } from "../icons";
import type { GetStartedDeck } from "./get-started-content";
import { GetStartedVisual } from "./get-started-visuals";

const SLIDE_SECONDS = 5;
const SLIDE_MS = SLIDE_SECONDS * 1000;

export function GetStartedDeckView({
  deck,
  resetToken = 0,
}: {
  deck: GetStartedDeck;
  resetToken?: number;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const activeSlide = deck.slides[activeSlideIndex] ?? deck.slides[0]!;
  const elapsedSeconds = activeSlideIndex * SLIDE_SECONDS;
  const totalSeconds = deck.slides.length * SLIDE_SECONDS;

  useEffect(() => {
    setActiveSlideIndex(0);
    setIsPlaying(false);
  }, [deck.id, resetToken]);

  useEffect(() => {
    if (!isPlaying || prefersReducedMotion) return;
    const timeout = window.setTimeout(() => {
      setActiveSlideIndex((current) => (current === deck.slides.length - 1 ? 0 : current + 1));
    }, SLIDE_MS);
    return () => window.clearTimeout(timeout);
  }, [activeSlideIndex, deck.slides.length, isPlaying, prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion) setIsPlaying(false);
  }, [prefersReducedMotion]);

  function showPreviousSlide() {
    setActiveSlideIndex((current) => (current === 0 ? deck.slides.length - 1 : current - 1));
  }

  function showNextSlide() {
    setActiveSlideIndex((current) => (current === deck.slides.length - 1 ? 0 : current + 1));
  }

  return (
    <section className="get-started-deck" aria-label={`${deck.label} deck`}>
      <div className="get-started-deck-body">
        <div className="get-started-deck-copy">
          <div className="get-started-eyebrow">
            <span className={`get-started-accent-dot accent-${activeSlide.accent}`} />
            <span>{activeSlide.eyebrow}</span>
          </div>
          <div className="get-started-slide-copy">
            <h2>{activeSlide.title}</h2>
            <p>{activeSlide.body}</p>
            <p>{activeSlide.detail}</p>
          </div>
        </div>
        <GetStartedVisual accent={activeSlide.accent} kind={activeSlide.visual} />
      </div>

      <div className="get-started-deck-footer">
        <div
          className="get-started-progress"
          style={{ gridTemplateColumns: `repeat(${deck.slides.length}, minmax(0, 1fr))` } as CSSProperties}
        >
          {deck.slides.map((slide, index) => {
            const isActive = index === activeSlideIndex;
            const isPast = index < activeSlideIndex;
            return (
              <button
                aria-label={`Show ${slide.title}`}
                className="get-started-progress-button"
                key={slide.id}
                onClick={() => setActiveSlideIndex(index)}
                type="button"
              >
                <span
                  className={`get-started-progress-fill accent-${slide.accent} ${
                    isActive || isPast ? "filled" : ""
                  }`}
                  style={{
                    transitionDuration: isActive && isPlaying && !prefersReducedMotion ? `${SLIDE_MS}ms` : "180ms",
                  }}
                />
              </button>
            );
          })}
        </div>

        <div className="get-started-controls">
          <div className="get-started-control-group">
            <button aria-label="Previous slide" className="get-started-icon-button" onClick={showPreviousSlide} type="button">
              <ArrowLeft size={16} />
            </button>
            <button
              aria-label={isPlaying ? "Pause slides" : "Play slides"}
              className="get-started-icon-button"
              onClick={() => setIsPlaying((current) => !current)}
              type="button"
            >
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button aria-label="Next slide" className="get-started-icon-button" onClick={showNextSlide} type="button">
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="get-started-time">
            {formatSlideTime(elapsedSeconds)} / {formatSlideTime(totalSeconds)}
          </div>
        </div>
      </div>
    </section>
  );
}

function formatSlideTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(media.matches);
    const handleChange = () => setPrefersReducedMotion(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}
