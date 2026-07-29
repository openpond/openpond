import type { Experience, Session } from "@openpond/contracts";

export function sidebarSessionsForExperience(
  sessions: Session[],
  experience: Experience
): Session[] {
  if (experience === "development") {
    return sessions.filter((session) => session.experience === "development");
  }
  return sessions.filter(
    (session) => session.experience === "chat" || session.experience === "work"
  );
}
