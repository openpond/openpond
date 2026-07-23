import {
  loadOpenPondProfileStateForRef,
  runProfileSkillCommand,
  runProfileSkillGoalCommand,
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
    executeProfileSkillGoal: ({
      request,
      profileRef,
    }: {
      request: Parameters<typeof runProfileSkillGoalCommand>[0];
      profileRef: Parameters<typeof loadOpenPondProfileStateForRef>[0];
    }) => runProfileSkillGoalCommand(request, {
      loadProfileState: () => loadOpenPondProfileStateForRef(profileRef),
    }),
  };
}
