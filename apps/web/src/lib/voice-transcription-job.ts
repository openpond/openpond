type VoiceTranscriptionJob = {
  controller: AbortController;
  promise: Promise<void>;
};

const jobs = new Map<string, VoiceTranscriptionJob>();
const listeners = new Map<string, Set<() => void>>();

function publish(channelKey: string) {
  for (const listener of listeners.get(channelKey) ?? []) listener();
}

export function voiceTranscriptionActive(channelKey: string): boolean {
  return jobs.has(channelKey);
}

export function subscribeVoiceTranscription(
  channelKey: string,
  listener: () => void,
): () => void {
  const channelListeners = listeners.get(channelKey) ?? new Set<() => void>();
  channelListeners.add(listener);
  listeners.set(channelKey, channelListeners);
  return () => {
    channelListeners.delete(listener);
    if (channelListeners.size === 0) listeners.delete(channelKey);
  };
}

export function cancelVoiceTranscription(channelKey: string) {
  jobs.get(channelKey)?.controller.abort();
}

export function startVoiceTranscription(
  channelKey: string,
  transcribe: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  cancelVoiceTranscription(channelKey);
  const controller = new AbortController();
  const job: VoiceTranscriptionJob = {
    controller,
    promise: Promise.resolve(),
  };
  job.promise = Promise.resolve()
    .then(() => transcribe(controller.signal))
    .catch((error) => {
      if (controller.signal.aborted) return;
      throw error;
    })
    .finally(() => {
      if (jobs.get(channelKey) !== job) return;
      jobs.delete(channelKey);
      publish(channelKey);
    });
  jobs.set(channelKey, job);
  publish(channelKey);
  return job.promise;
}
