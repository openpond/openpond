type VoiceTranscriptionJob = {
  controller: AbortController;
  promise: Promise<void>;
  submitRequested: boolean;
};

const jobs = new Map<string, VoiceTranscriptionJob>();
const listeners = new Map<string, Set<() => void>>();
const submitRequestListeners = new Map<string, Set<() => boolean>>();

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

export function subscribeVoiceSubmitRequest(
  channelKey: string,
  listener: () => boolean,
): () => void {
  const channelListeners =
    submitRequestListeners.get(channelKey) ?? new Set<() => boolean>();
  channelListeners.add(listener);
  submitRequestListeners.set(channelKey, channelListeners);
  return () => {
    channelListeners.delete(listener);
    if (channelListeners.size === 0) submitRequestListeners.delete(channelKey);
  };
}

export function requestVoiceInputSubmit(channelKey: string): boolean {
  const job = jobs.get(channelKey);
  if (job) {
    job.submitRequested = true;
    return true;
  }
  for (const listener of submitRequestListeners.get(channelKey) ?? []) {
    if (listener()) return true;
  }
  return false;
}

export function startVoiceTranscription(
  channelKey: string,
  transcribe: (
    signal: AbortSignal,
    submitRequested: () => boolean,
  ) => Promise<void>,
  options: { submit?: boolean } = {},
): Promise<void> {
  cancelVoiceTranscription(channelKey);
  const controller = new AbortController();
  const job: VoiceTranscriptionJob = {
    controller,
    promise: Promise.resolve(),
    submitRequested: options.submit ?? false,
  };
  job.promise = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) return;
      return transcribe(controller.signal, () => job.submitRequested);
    })
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
