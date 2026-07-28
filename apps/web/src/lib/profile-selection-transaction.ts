import type {
  OpenPondProfileLibrary,
  OpenPondProfileRef,
  OpenPondProfileState,
  Session,
} from "@openpond/contracts";

type ProfileSelectionResult = {
  profile: OpenPondProfileState;
  library: OpenPondProfileLibrary;
};

export async function selectComposerProfileTransaction(input: {
  ref: OpenPondProfileRef;
  session: Session | null;
  selectProfile: (ref: OpenPondProfileRef) => Promise<ProfileSelectionResult>;
  patchSession: (
    sessionId: string,
    currentProfile: OpenPondProfileRef | null,
  ) => Promise<Session>;
}): Promise<{ selected: ProfileSelectionResult; session: Session | null }> {
  const originalRef = input.session?.currentProfile ?? null;
  const updatedSession = input.session
    ? await input.patchSession(input.session.id, input.ref)
    : null;
  try {
    return {
      selected: await input.selectProfile(input.ref),
      session: updatedSession,
    };
  } catch (error) {
    if (updatedSession) {
      try {
        await input.patchSession(updatedSession.id, originalRef);
      } catch {
        // Preserve the selection error; the next bootstrap will surface persisted state.
      }
    }
    throw error;
  }
}
