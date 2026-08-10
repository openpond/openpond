import type { Session } from "@openpond/contracts";

export type SessionTaskset = {
  id: string;
  name: string;
};

export function sessionTaskset(
  session: Pick<Session, "metadata">,
): SessionTaskset | null {
  const id =
    stringMetadata(session.metadata?.trainingTasksetId) ??
    stringMetadata(session.metadata?.tasksetId);
  if (!id) return null;
  return {
    id,
    name:
      stringMetadata(session.metadata?.trainingTasksetName) ??
      stringMetadata(session.metadata?.tasksetName) ??
      tasksetNameFromId(id),
  };
}

export function tasksetNameFromId(id: string): string {
  const withoutHash = id.replace(/[-_][a-f0-9]{8,}$/i, "");
  const words = withoutHash
    .replace(/^(?:benchmark[-_])?taskset[-_]/i, "")
    .replace(/^benchmark[-_]/i, "")
    .split(/[-_]+/)
    .filter(Boolean);
  if (words.length === 0) return "Taskset";
  return words
    .map((word) =>
      /^[A-Z0-9]{2,}$/.test(word)
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    )
    .join(" ");
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
