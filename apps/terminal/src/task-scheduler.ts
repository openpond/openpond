export type TerminalTimer = ReturnType<typeof setTimeout>;

export type SerialTaskScheduler = {
  run: <T>(task: () => Promise<T> | T) => Promise<T>;
};

export type LatestWinsTaskScheduler = {
  request: (task: () => void) => void;
  flush: () => void;
  cancel: () => void;
};

export function createSerialTaskScheduler(): SerialTaskScheduler {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run(task) {
      const runTask = () => Promise.resolve().then(task);
      const next = tail.then(runTask, runTask);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

export function createLatestWinsTaskScheduler(options: {
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TerminalTimer;
  clearTimer?: (timer: TerminalTimer) => void;
} = {}): LatestWinsTaskScheduler {
  const delayMs = Math.max(0, options.delayMs ?? 16);
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let latestTask: (() => void) | null = null;
  let timer: TerminalTimer | null = null;

  function clearPendingTimer(): void {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  function runLatest(): void {
    timer = null;
    const task = latestTask;
    latestTask = null;
    task?.();
  }

  return {
    request(task) {
      latestTask = task;
      if (timer) return;
      timer = setTimer(runLatest, delayMs);
    },
    flush() {
      clearPendingTimer();
      runLatest();
    },
    cancel() {
      latestTask = null;
      clearPendingTimer();
    },
  };
}
