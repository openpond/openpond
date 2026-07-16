export type TerminalExitLatch = {
  readonly requested: boolean;
  request(): void;
  wait(): Promise<void>;
};

export function createTerminalExitLatch(): TerminalExitLatch {
  let requested = false;
  let resolveWait: (() => void) | null = null;

  return {
    get requested() {
      return requested;
    },
    request() {
      if (requested) return;
      requested = true;
      resolveWait?.();
    },
    wait() {
      if (requested) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveWait = resolve;
        if (requested) resolve();
      });
    },
  };
}
