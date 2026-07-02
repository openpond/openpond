export type RecordedVoiceAudio = {
  blob: Blob;
  durationMs: number;
  sampleRate: number;
};

export type VoiceRecorder = {
  stop: () => Promise<RecordedVoiceAudio>;
  cancel: () => Promise<void>;
};

type RecorderState = {
  audioContext: AudioContext;
  chunks: Float32Array[];
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
  startedAt: number;
  stopped: boolean;
};

export function canRecordVoice(): boolean {
  return Boolean(navigator.mediaDevices && typeof AudioContext !== "undefined");
}

export async function startVoiceRecorder(): Promise<VoiceRecorder> {
  if (!canRecordVoice()) {
    throw new Error("Voice recording is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  const state: RecorderState = {
    audioContext,
    chunks: [],
    processor,
    silentGain,
    source,
    stream,
    startedAt: performance.now(),
    stopped: false,
  };

  processor.onaudioprocess = (event) => {
    if (state.stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    state.chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  return {
    stop: () => stopRecorder(state, true),
    cancel: () => stopRecorder(state, false).then(() => undefined),
  };
}

async function stopRecorder(state: RecorderState, encode: boolean): Promise<RecordedVoiceAudio> {
  if (state.stopped) {
    return {
      blob: new Blob([], { type: "audio/wav" }),
      durationMs: 0,
      sampleRate: state.audioContext.sampleRate,
    };
  }
  state.stopped = true;
  state.processor.disconnect();
  state.silentGain.disconnect();
  state.source.disconnect();
  for (const track of state.stream.getTracks()) track.stop();
  await state.audioContext.close().catch(() => undefined);

  const durationMs = Math.max(0, performance.now() - state.startedAt);
  if (!encode) {
    return {
      blob: new Blob([], { type: "audio/wav" }),
      durationMs,
      sampleRate: state.audioContext.sampleRate,
    };
  }
  const samples = mergeChunks(state.chunks);
  if (samples.length === 0) throw new Error("No microphone audio was captured.");
  return {
    blob: encodeWav(samples, state.audioContext.sampleRate),
    durationMs,
    sampleRate: state.audioContext.sampleRate,
  };
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
