export type TerminalRenderTimer = ReturnType<typeof setTimeout>;

export type TerminalRenderScheduler = {
  request: () => void;
  flush: () => void;
  cancel: () => void;
};

export type TerminalRenderSchedulerOptions = {
  maxFps?: number;
  setTimer?: (callback: () => void, delayMs: number) => TerminalRenderTimer;
  clearTimer?: (timer: TerminalRenderTimer) => void;
};

const DEFAULT_MAX_FPS = 30;

export function createTerminalRenderScheduler(
  render: () => void,
  options: TerminalRenderSchedulerOptions = {},
): TerminalRenderScheduler {
  const maxFps = Number.isFinite(options.maxFps) && options.maxFps! > 0 ? options.maxFps! : DEFAULT_MAX_FPS;
  const frameMs = Math.max(1, Math.ceil(1000 / maxFps));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: TerminalRenderTimer | null = null;
  let pending = false;

  function clearPendingTimer(): void {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  function paint(): void {
    timer = null;
    if (!pending) return;
    pending = false;
    render();
  }

  return {
    request() {
      pending = true;
      if (timer) return;
      timer = setTimer(paint, frameMs);
    },
    flush() {
      if (!pending) {
        clearPendingTimer();
        return;
      }
      pending = false;
      clearPendingTimer();
      render();
    },
    cancel() {
      pending = false;
      clearPendingTimer();
    },
  };
}
