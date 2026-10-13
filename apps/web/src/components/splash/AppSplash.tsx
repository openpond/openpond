import { useEffect, useState } from "react";
import type { AppStartupState } from "../../startup/app-startup";
import { OpenPondLockup, OPENPOND_WORDMARK_LENGTH } from "../brand/OpenPondLockup";

const LETTER_REVEAL_START_MS = 520;
const LETTER_REVEAL_STEP_MS = 240;

function shouldReduceSplashMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function AppSplash({ startup }: { startup: AppStartupState }) {
  const [visibleLetterCount, setVisibleLetterCount] = useState(() =>
    shouldReduceSplashMotion() ? OPENPOND_WORDMARK_LENGTH : 0,
  );

  useEffect(() => {
    if (shouldReduceSplashMotion()) {
      setVisibleLetterCount(OPENPOND_WORDMARK_LENGTH);
      return;
    }

    const timers = Array.from({ length: OPENPOND_WORDMARK_LENGTH }, (_, index) =>
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
    <main className="app-splash" aria-busy={!startup.error || startup.retrying} aria-label={startup.label} role="status">
      <OpenPondLockup visibleLetterCount={visibleLetterCount} />
      <span className="app-splash-status">{startup.error ? "Unable to load OpenPond" : startup.label}</span>
      {startup.error ? <div className="app-splash-recovery">
        <p role="alert">{startup.error}</p>
        <button className="app-splash-retry" type="button" onClick={startup.retry} disabled={startup.retrying}>
          {startup.retrying ? "Retrying…" : "Try again"}
        </button>
      </div> : null}
    </main>
  );
}
