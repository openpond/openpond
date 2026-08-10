import type { Experience, Session } from "@openpond/contracts";

export function sidebarSessionsForExperience(
  sessions: Session[],
  experience: Experience
): Session[] {
  if (experience === "chat") {
    return sessions.filter((session) => session.experience === "chat");
  }
  return sessions.filter((session) =>
    session.experience === "work" || session.experience === "development"
  );
}

export function projectlessSidebarSessionLabel(
  session: Pick<Session, "experience">
): "Chat" | "Work" {
  return session.experience === "chat" ? "Chat" : "Work";
}
