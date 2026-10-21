import { useCallback, useEffect, useId, useRef } from "react";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { insertVoiceTranscript } from "../../lib/voice-text";
import { cancelVoiceTranscription } from "../../lib/voice-transcription-job";
import { VoiceInputButton } from "../voice/VoiceInputButton";

type Props = {
  id: string;
  value: string;
  disabled: boolean;
  connection: ClientConnection | null;
  showToast: ShowAppToast;
  onChange(value: string, submit?: boolean): void;
  activeVoiceChannel: string | null;
  onVoiceActiveChange(channel: string, active: boolean): void;
};

export function NativeQuestionAnswer({ id, value, disabled, connection, showToast, onChange, activeVoiceChannel, onVoiceActiveChange }: Props) {
  const instanceId = useId();
  const channel = `question-answer:${instanceId}`;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const current = useRef({ value, disabled, onChange });
  current.current = { value, disabled, onChange };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelVoiceTranscription(channel); };
  }, [channel]);
  useEffect(() => {
    if (disabled) cancelVoiceTranscription(channel);
  }, [channel, disabled]);
  const handleVoiceActiveChange = useCallback((active: boolean) => onVoiceActiveChange(channel, active), [channel, onVoiceActiveChange]);
  const handleTranscript = useCallback((text: string, { submit }: { submit: boolean }) => {
    if (!mounted.current || current.current.disabled) return;
    const result = insertVoiceTranscript(current.current.value, text, inputRef.current?.selectionStart ?? current.current.value.length);
    current.current.onChange(result.value.slice(0, 8000), submit);
  }, []);

  return (
    <div className="native-question-custom">
      <label className="sr-only" htmlFor={id}>Your answer</label>
      <textarea ref={inputRef} id={id} maxLength={8000} rows={2} value={value} placeholder="Write your answer…" disabled={disabled}
        onChange={event => onChange(event.target.value)} />
      <div className="native-question-answer-controls">
        {!disabled ? <VoiceInputButton connection={connection} showToast={showToast} buttonClassName="native-question-mic" disabled={disabled || !connection || Boolean(activeVoiceChannel && activeVoiceChannel !== channel)}
          transcriptionChannelKey={channel} onActiveChange={handleVoiceActiveChange} onTranscript={handleTranscript} /> : null}
      </div>
    </div>
  );
}
