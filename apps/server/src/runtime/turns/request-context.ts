import type { Turn } from "@openpond/contracts";

export function isTerminalOneShotTurn(turn: Turn): boolean {
  const metadata = turn.metadata ?? {};
  if (metadata.openpondTerminalMode === "one-shot") return true;
  const terminal = metadata.openpondTerminal;
  return (
    Boolean(terminal) &&
    typeof terminal === "object" &&
    !Array.isArray(terminal) &&
    (terminal as Record<string, unknown>).mode === "one-shot"
  );
}
