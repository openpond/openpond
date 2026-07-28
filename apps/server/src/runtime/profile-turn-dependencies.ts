import {
  loadOpenPondProfileStateForRef,
  runProfileSkillCommand,
} from "@openpond/cloud";

export function createProfileTurnDependencies() {
  return {
    loadOpenPondProfileStateForRef,
    executeProfileSkillCommand: ({ prompt, profileRef }: {
      prompt: string;
      profileRef: Parameters<typeof loadOpenPondProfileStateForRef>[0];
    }) => runProfileSkillCommand(prompt, {
      loadProfileState: () => loadOpenPondProfileStateForRef(profileRef),
    }),
  };
}
