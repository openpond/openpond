import { useMemo, type CSSProperties } from "react";

const BAR_COUNT = 96;
const EMPTY_LEVELS = Array.from({ length: BAR_COUNT }, () => 0);

export function emptyVoiceWaveformLevels(): number[] {
  return [...EMPTY_LEVELS];
}

export function appendVoiceWaveformLevel(
  levels: number[],
  level: number,
): number[] {
  return [...levels.slice(-(BAR_COUNT - 1)), Math.max(0, Math.min(1, level))];
}

export function VoiceRecordingWaveform({ levels }: { levels: number[] }) {
  const normalizedLevels = useMemo(
    () =>
      levels.length >= BAR_COUNT
        ? levels.slice(-BAR_COUNT)
        : [...EMPTY_LEVELS.slice(levels.length), ...levels],
    [levels],
  );

  return (
    <span
      className="voice-recording-waveform"
      role="img"
      aria-label="Live microphone level"
    >
      {normalizedLevels.map((level, index) => (
        <span
          className="voice-recording-bar"
          // Positions are stable while their sampled heights change.
          key={index}
          style={{ "--voice-level": level } as CSSProperties}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
