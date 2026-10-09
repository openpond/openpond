import { ArrowUp, Pause, Square } from "../icons";

export function ComposerSubmissionControls({
  running,
  sendDisabled,
  hasComposerInput,
  sendTooltip,
  stopIcon,
  stopLabel,
  voiceInputActive,
  onSend,
  onStop,
}: {
  running: boolean;
  sendDisabled: boolean;
  hasComposerInput: boolean;
  sendTooltip: string;
  stopIcon: "pause" | "stop";
  stopLabel: string;
  voiceInputActive: boolean;
  onSend: () => void;
  onStop: (reason?: string) => Promise<boolean | void> | boolean | void;
}) {
  const showStop = running && !hasComposerInput && !voiceInputActive;
  const controlLabel = showStop ? stopLabel : sendTooltip;
  return (
    <button
      type="button"
      className={`send-button ${showStop ? "stop-button" : ""}`.trim()}
      disabled={!showStop && sendDisabled && !voiceInputActive}
      data-tooltip={controlLabel}
      aria-label={controlLabel}
      onClick={showStop ? () => void onStop() : onSend}
    >
      {showStop ? (
        stopIcon === "pause" ? (
          <Pause size={15} />
        ) : (
          <Square size={13} fill="currentColor" />
        )
      ) : (
        <ArrowUp size={18} />
      )}
    </button>
  );
}
