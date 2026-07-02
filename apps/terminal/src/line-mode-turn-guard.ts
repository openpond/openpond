import type { RuntimeEvent } from "@openpond/contracts";

export const LINE_MODE_TURN_RUNNING_MESSAGE =
  "A turn is already running. Wait for it to finish before sending another line.";

export const TERMINAL_TURN_RUNNING_MESSAGE =
  "A turn is already running. Press Ctrl+C to interrupt it.";

export type TerminalTurnSubmissionGuard = {
  isRunning: () => boolean;
  tryStartSubmission: () => boolean;
  failSubmission: () => void;
  applyRuntimeEvent: (event: RuntimeEvent) => void;
};

export type LineModeTurnGuard = TerminalTurnSubmissionGuard;

export function createTerminalTurnSubmissionGuard(): TerminalTurnSubmissionGuard {
  let running = false;

  return {
    isRunning() {
      return running;
    },
    tryStartSubmission() {
      if (running) return false;
      running = true;
      return true;
    },
    failSubmission() {
      running = false;
    },
    applyRuntimeEvent(event) {
      if (event.name === "turn.started") running = true;
      if (event.name === "turn.completed" || event.name === "turn.failed" || event.name === "turn.interrupted") {
        running = false;
      }
    },
  };
}

export function createLineModeTurnGuard(): LineModeTurnGuard {
  return createTerminalTurnSubmissionGuard();
}
