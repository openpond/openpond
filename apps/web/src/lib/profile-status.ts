import type { BootstrapPayload } from "@openpond/contracts";

type ProfileState = BootstrapPayload["profile"] | null | undefined;

export function profileHasUncommittedLocalChanges(profile: ProfileState): boolean {
  if (!profile || profile.mode !== "local") return false;
  return Boolean(
    profile.git?.dirty ||
      profile.summary.state === "dirty" ||
      profile.summary.state === "pending_commit",
  );
}
