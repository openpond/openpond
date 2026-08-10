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
      "Taskset",
  };
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
