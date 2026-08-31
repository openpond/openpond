import type { Session } from "@openpond/contracts";

type ManagedLocalWorkSession = Pick<
  Session,
  | "experience"
  | "workspaceKind"
  | "localProjectId"
  | "cloudProjectId"
  | "cwd"
  | "metadata"
>;

export function isManagedLocalWorkSession(
  session: ManagedLocalWorkSession,
): boolean {
  return Boolean(
    session.experience === "work" &&
      !session.workspaceKind &&
      !session.localProjectId &&
      !session.cloudProjectId &&
      session.metadata?.workspaceTarget === "local" &&
      session.cwd,
  );
}
