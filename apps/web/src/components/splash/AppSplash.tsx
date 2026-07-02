import { useEffect, useState } from "react";
import type { AppStartupState } from "../../startup/app-startup";

const WORDMARK = "OpenPond".split("");
const LETTER_REVEAL_START_MS = 520;
const LETTER_REVEAL_STEP_MS = 240;

function shouldReduceSplashMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function AppSplash({ startup }: { startup: AppStartupState }) {
  const [visibleLetterCount, setVisibleLetterCount] = useState(() =>
    shouldReduceSplashMotion() ? WORDMARK.length : 0,
  );

  useEffect(() => {
    if (shouldReduceSplashMotion()) {
      setVisibleLetterCount(WORDMARK.length);
      return;
    }

    const timers = WORDMARK.map((_, index) =>
      window.setTimeout(
        () => setVisibleLetterCount(index + 1),
        LETTER_REVEAL_START_MS + LETTER_REVEAL_STEP_MS * index,
      ),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return (
    <main className="app-splash" aria-busy="true" aria-label={startup.label} role="status">
      <div className="app-splash-lockup" data-stage={startup.stage}>
        <div className="app-splash-mark">
          <img alt="OpenPond" className="app-splash-logo" decoding="async" src="/openpond-icon.png" />
        </div>
        <span
          aria-hidden="true"
          className={`app-splash-wordmark${visibleLetterCount > 0 ? " is-visible" : ""}`}
        >
          {WORDMARK.slice(0, visibleLetterCount).map((letter, index) => (
            <span className="app-splash-letter" key={`${letter}-${index}`}>
              {letter}
            </span>
          ))}
        </span>
      </div>
      <span className="app-splash-status">{startup.label}</span>
    </main>
  );
}
