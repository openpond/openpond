import { expect, test, vi } from "vitest";
import { ComposerSubmissionControls } from "../apps/web/src/components/chat/ComposerSubmissionControls";

// Failure story: clicking the primary button with a draft interrupts the active
// task instead of submitting that draft to the composer's queue/send handler.
test("a running composer sends its draft and only stops when the draft is empty", () => {
  const onSend = vi.fn(), onStop = vi.fn();
  const props = { running: true, hasComposerInput: true, sendDisabled: false,
    sendTooltip: "Queue for next turn", stopLabel: "Stop response", stopIcon: "stop" as const,
    voiceInputActive: false, onSend, onStop };
  const send = ComposerSubmissionControls(props);
  expect(send.props.disabled).toBe(false);
  send.props.onClick();
  expect(onSend).toHaveBeenCalledOnce();
  expect(onStop).not.toHaveBeenCalled();

  const preparing = ComposerSubmissionControls({ ...props, sendDisabled: true });
  expect(preparing.props.disabled).toBe(true);

  const stop = ComposerSubmissionControls({ ...props, hasComposerInput: false, sendDisabled: true });
  expect(stop.props.disabled).toBe(false);
  stop.props.onClick();
  expect(onStop).toHaveBeenCalledOnce();

  const dictating = ComposerSubmissionControls({ ...props, hasComposerInput: false, sendDisabled: true, voiceInputActive: true });
  expect(dictating.props.disabled).toBe(false);
  dictating.props.onClick();
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(onStop).toHaveBeenCalledOnce();
});
