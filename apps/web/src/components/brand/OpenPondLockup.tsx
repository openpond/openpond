import { OPENPOND_ICON_URL } from "../../lib/public-assets";

const WORDMARK = "OpenPond".split("");

export function OpenPondLockup({
  visibleLetterCount = WORDMARK.length,
}: {
  visibleLetterCount?: number;
}) {
  const letters = WORDMARK.slice(0, Math.max(0, Math.min(visibleLetterCount, WORDMARK.length)));
  return (
    <div className="app-splash-lockup">
      <div className="app-splash-mark">
        <img alt="OpenPond" className="app-splash-logo" decoding="async" src={OPENPOND_ICON_URL} />
      </div>
      <span
        aria-hidden="true"
        className={`app-splash-wordmark${letters.length > 0 ? " is-visible" : ""}`}
      >
        {letters.map((letter, index) => (
          <span className="app-splash-letter" key={`${letter}-${index}`}>
            {letter}
          </span>
        ))}
      </span>
    </div>
  );
}

export const OPENPOND_WORDMARK_LENGTH = WORDMARK.length;
