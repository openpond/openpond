import { createHash } from "node:crypto";
import type { Turn } from "@openpond/contracts";
import type { ConnectedSession } from "@openpond/evals/connected-evidence";

export function nativeEventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nativeEventText).filter(Boolean).join("\n");
  if (value && typeof value === "object") { const object = value as Record<string, unknown>; return typeof object.text === "string" ? object.text : typeof object.content === "string" ? object.content : ""; }
  return "";
}

/** Match only prompts actually issued by this local turn, during its lifetime. */
export function ownedNativeBoundaryIds(native: Pick<ConnectedSession, "events" | "boundaries">, turns: Array<Pick<Turn, "metadata" | "startedAt" | "completedAt">>): Set<string> {
  return new Set(native.boundaries.filter((boundary) => {
    const request = native.events[boundary.start];
    if (boundary.projection !== "turn" || !request?.occurredAt) return false;
    const promptHash = createHash("sha256").update(nativeEventText(request.content)).digest("hex");
    const occurred = Date.parse(request.occurredAt);
    return turns.some((turn) => (turn.metadata?.nativePromptHash === promptHash || (Array.isArray(turn.metadata?.nativePromptHashes) && turn.metadata.nativePromptHashes.includes(promptHash))) && occurred >= Date.parse(turn.startedAt) && (!turn.completedAt || occurred <= Date.parse(turn.completedAt)));
  }).map((boundary) => boundary.id));
}
