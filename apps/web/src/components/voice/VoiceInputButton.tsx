import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "../icons";
import { api, type ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { canRecordVoice, startVoiceRecorder, type RecordedVoiceAudio, type VoiceRecorder } from "../../lib/voice-recorder";
import {
  appendVoiceWaveformLevel,
  emptyVoiceWaveformLevels,
  VoiceRecordingWaveform,
} from "./VoiceRecordingWaveform";

type VoiceInputPhase = "idle" | "starting" | "recording" | "transcribing";

type VoiceInputButtonProps = {
  connection: ClientConnection | null;
  buttonClassName: string;
  wrapperClassName?: string;
  disabled?: boolean;
  iconSize?: number;
  language?: string;
  showToast: ShowAppToast;
  onTranscript: (text: string) => void;
};

const MAX_RECORDING_MS = 120_000;
const VOICE_SETUP_NOTICE_KEY = "openpond.voice.setupNoticeAcknowledged";
const VOICE_SETUP_NOTICE_MESSAGE =
  "Voice dictation runs locally with whisper.cpp. OpenPond uses a local whisper-cli binary and downloads the voice model on first use.";

export function VoiceInputButton({
  connection,
  buttonClassName,
  wrapperClassName = "",
  disabled = false,
  iconSize = 16,
  language = "en",
  showToast,
  onTranscript,
}: VoiceInputButtonProps) {
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const transcriptionControllerRef = useRef<AbortController | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const connectionRef = useRef(connection);
  const disabledRef = useRef(disabled);
  const setupNoticeAcknowledgedRef = useRef(readVoiceSetupNoticeAcknowledged());
  connectionRef.current = connection;
  disabledRef.current = disabled;
  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [waveformLevels, setWaveformLevels] = useState<number[]>(
    emptyVoiceWaveformLevels,
  );
  const busy = phase === "transcribing";
  const starting = phase === "starting";
  const recording = phase === "recording";
  const transcribing = phase === "transcribing";
  const active = recording || transcribing;

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const cancelRecording = useCallback(async () => {
    clearStopTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setPhase("idle");
    setWaveformLevels(emptyVoiceWaveformLevels());
    if (recorder) await recorder.cancel().catch(() => undefined);
  }, [clearStopTimer]);

  const transcribe = useCallback(
    async (audio: RecordedVoiceAudio, signal: AbortSignal) => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) throw new Error("Voice input is still connecting.");
      const status = await api.voiceTranscriptionStatus(currentConnection, {
        signal,
      });
      if (!status.binaryPath) {
        throw new Error(status.installHint ?? "Install whisper.cpp to use dictation.");
      }
      const response = await api.transcribeVoice(currentConnection, {
        audioBase64: await blobToBase64(audio.blob),
        durationMs: Math.round(audio.durationMs),
        language,
        mimeType: "audio/wav",
      }, {
        signal,
      });
      if (signal.aborted) return;
      onTranscript(response.text);
    },
    [language, onTranscript],
  );

  const cancelTranscription = useCallback(() => {
    transcriptionControllerRef.current?.abort();
    transcriptionControllerRef.current = null;
    setMessage(null);
    setPhase("idle");
    setWaveformLevels(emptyVoiceWaveformLevels());
  }, []);

  const stopAndTranscribe = useCallback(async () => {
    clearStopTimer();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    const controller = new AbortController();
    transcriptionControllerRef.current?.abort();
    transcriptionControllerRef.current = controller;
    setPhase("transcribing");
    setMessage(null);
    try {
      const audio = await recorder.stop();
      if (controller.signal.aborted) return;
      await transcribe(audio, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(voiceErrorMessage(error));
    } finally {
      if (transcriptionControllerRef.current === controller) {
        transcriptionControllerRef.current = null;
        setPhase("idle");
        setWaveformLevels(emptyVoiceWaveformLevels());
      }
    }
  }, [clearStopTimer, transcribe]);

  const beginRecording = useCallback(async () => {
    if (disabledRef.current) return;
    const currentConnection = connectionRef.current;
    if (!currentConnection) {
      setMessage("Voice input is still connecting.");
      return;
    }
    if (!canRecordVoice()) {
      setMessage("Voice recording is not available in this browser.");
      return;
    }
    setMessage(null);
    setPhase("starting");
    try {
      const desktopPermission = await window.openpond?.requestMicrophoneAccess?.();
      if (desktopPermission === false) throw new Error("Microphone access is denied.");
      const recorder = await startVoiceRecorder({
        onAudioLevel: (level) => {
          setWaveformLevels((current) =>
            appendVoiceWaveformLevel(current, level),
          );
        },
      });
      recorderRef.current = recorder;
      setWaveformLevels(emptyVoiceWaveformLevels());
      setPhase("recording");
      stopTimerRef.current = window.setTimeout(() => {
        void stopAndTranscribe();
      }, MAX_RECORDING_MS);
    } catch (error) {
      setMessage(voiceErrorMessage(error));
      await cancelRecording();
    }
  }, [cancelRecording, stopAndTranscribe]);

  const startRecording = useCallback(() => {
    if (setupNoticeAcknowledgedRef.current) {
      void beginRecording();
      return;
    }

    showToast(VOICE_SETUP_NOTICE_MESSAGE, "info", {
      actionLabel: "Continue",
      persistent: true,
      onAction: () => {
        setupNoticeAcknowledgedRef.current = true;
        writeVoiceSetupNoticeAcknowledged();
        void beginRecording();
      },
    });
  }, [beginRecording, showToast]);

  useEffect(() => {
    if (!message || recording || busy) return;
    const timeout = window.setTimeout(() => setMessage(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [busy, message, recording]);

  useEffect(() => {
    return () => {
      transcriptionControllerRef.current?.abort();
      void cancelRecording();
    };
  }, [cancelRecording]);

  return (
    <span className={`voice-input-control ${wrapperClassName} ${starting ? "starting" : ""} ${recording ? "recording" : ""} ${transcribing ? "transcribing" : ""}`.trim()}>
      {active ? (
        <span className="voice-recording-strip">
          <span className="sr-only" role="status">
            {transcribing ? "Transcribing audio" : "Recording voice"}
          </span>
          <button
            type="button"
            className="voice-recording-action cancel"
            aria-label={transcribing ? "Cancel transcription" : "Cancel dictation"}
            onClick={() => {
              if (transcribing) cancelTranscription();
              else void cancelRecording();
            }}
          >
            <X size={15} />
          </button>
          {transcribing ? (
            <>
              <span className="voice-transcribing-label" aria-hidden="true">
                Transcribing
                <span className="voice-transcribing-dots">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </span>
              <span className="voice-recording-action-spacer" aria-hidden="true" />
            </>
          ) : (
            <>
              <VoiceRecordingWaveform levels={waveformLevels} />
              <button
                type="button"
                className="voice-recording-action stop"
                aria-label="Stop and transcribe"
                onClick={() => void stopAndTranscribe()}
              >
                <Square size={10} fill="currentColor" />
              </button>
            </>
          )}
        </span>
      ) : (
        <button
          type="button"
          className={`voice-input-trigger ${buttonClassName} ${starting ? "starting" : ""}`.trim()}
          aria-label={starting ? "Starting dictation" : "Dictate"}
          disabled={disabled || busy || starting}
          onClick={startRecording}
        >
          <Mic size={iconSize} />
        </button>
      )}
      {message && !active ? (
        <span className="voice-input-status" role="status">
          {message}
        </span>
      ) : null}
    </span>
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

function voiceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/NotAllowedError|Permission denied|denied/i.test(message)) {
    return "Microphone access is denied.";
  }
  if (/NotFoundError|Requested device not found/i.test(message)) {
    return "No microphone was found.";
  }
  return message || "Voice input failed.";
}

function readVoiceSetupNoticeAcknowledged(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(VOICE_SETUP_NOTICE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeVoiceSetupNoticeAcknowledged(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOICE_SETUP_NOTICE_KEY, "true");
  } catch {
    // Browsers can block storage; the in-memory ref still handles this session.
  }
}
