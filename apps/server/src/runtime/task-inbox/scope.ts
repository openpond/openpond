import type { Session } from "@openpond/contracts";

/** Paths are coordination hints, never an authorization boundary. */
export function tasksShareProject(left: Session, right: Session): boolean {
  if (left.cloudTeamId !== right.cloudTeamId) return false;
  if (left.localProjectId && right.localProjectId) return left.localProjectId === right.localProjectId;
  if (left.cloudProjectId && right.cloudProjectId) return left.cloudProjectId === right.cloudProjectId;
  return Boolean(left.workspaceId && right.workspaceId && left.workspaceKind === right.workspaceKind && left.workspaceId === right.workspaceId);
}

export async function canCoordinateTasks(left: Session, right: Session, getSession: (id: string) => Promise<Session>): Promise<boolean> {
  if (left.id === right.id || left.systemKind || right.systemKind || left.status === "closed" || right.status === "closed" || left.archived || right.archived) return false;
  if (tasksShareProject(left, right)) return true;
  if (left.cloudTeamId !== right.cloudTeamId) return false;
  const root = async (session: Session): Promise<string> => {
    const visited = new Set<string>();
    let current = session;
    while (current.parentSessionId) {
      if (visited.has(current.id) || visited.size >= 32) throw new Error("Invalid task ancestry.");
      visited.add(current.id);
      current = await getSession(current.parentSessionId);
    }
    return current.id;
  };
  return await root(left) === await root(right);
}
