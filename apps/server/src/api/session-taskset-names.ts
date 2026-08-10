import type { Session, Taskset } from "@openpond/contracts";

export async function sessionsWithTasksetNames<
  SessionShell extends Pick<Session, "metadata">,
>(
  sessions: readonly SessionShell[],
  getTaskset: (
    tasksetId: string
  ) => Promise<Pick<Taskset, "id" | "name"> | null>
): Promise<SessionShell[]> {
  const ids = new Set(
    sessions.flatMap((session) => {
      const id = sessionTasksetId(session);
      return id ? [id] : [];
    })
  );
  if (ids.size === 0) return [...sessions];

  const tasksets = await Promise.all([...ids].map((id) => getTaskset(id)));
  const nameById = new Map(
    tasksets.flatMap((taskset) =>
      taskset ? ([[taskset.id, taskset.name]] as const) : []
    )
  );
  return sessions.map((session) => {
    const id = sessionTasksetId(session);
    const name = id ? nameById.get(id) : null;
    if (!name || sessionTasksetName(session)) return session;
    const trainingSession = stringMetadata(
      session.metadata?.trainingTasksetId
    );
    return {
      ...session,
      metadata: {
        ...session.metadata,
        [trainingSession ? "trainingTasksetName" : "tasksetName"]: name,
      },
    } as SessionShell;
  });
}

function sessionTasksetId(session: Pick<Session, "metadata">): string | null {
  return (
    stringMetadata(session.metadata?.trainingTasksetId) ??
    stringMetadata(session.metadata?.tasksetId)
  );
}

function sessionTasksetName(
  session: Pick<Session, "metadata">
): string | null {
  return (
    stringMetadata(session.metadata?.trainingTasksetName) ??
    stringMetadata(session.metadata?.tasksetName)
  );
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
