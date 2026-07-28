import type {
  OpenPondProfileSkill,
  OpenPondProfileState,
} from "./local-profile-types.js";
import { loadOpenPondProfileState } from "./local-profile.js";

export type ProfileSkillCommandResult = {
  handled: true;
  action: "list" | "help";
  message: string;
  skills?: OpenPondProfileSkill[];
  profile: OpenPondProfileState;
};

type ProfileSkillCommandDeps = {
  loadProfileState: () => Promise<OpenPondProfileState>;
};

export async function runProfileSkillCommandFromPrompt(
  prompt: string,
): Promise<ProfileSkillCommandResult | null> {
  return runProfileSkillCommand(prompt, {
    loadProfileState: loadOpenPondProfileState,
  });
}

export async function runProfileSkillCommand(
  prompt: string,
  deps: ProfileSkillCommandDeps,
): Promise<ProfileSkillCommandResult | null> {
  const action = readOnlyProfileSkillAction(prompt);
  if (!action) return null;
  const profile = await deps.loadProfileState();
  return action === "help" ? profileSkillHelp(profile) : listProfileSkills(profile);
}

function readOnlyProfileSkillAction(prompt: string): "list" | "help" | null {
  const slash = /^\/skill(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!slash) return null;
  const rest = slash[1]?.trim().toLowerCase() ?? "";
  if (!rest || rest === "list") return "list";
  if (rest === "help") return "help";
  return null;
}

function profileSkillHelp(profile: OpenPondProfileState): ProfileSkillCommandResult {
  return {
    handled: true,
    action: "help",
    profile,
    message: [
      "Profile skills support:",
      "- /skill list",
      "- /skill create <what the skill should help with>",
      "- /skill create <skill-name>: <what the skill should help with>",
      "- /skill create --name <skill-name> <what the skill should help with>",
      "- /skill edit <skill-name> <change request>",
      "",
      "Create and edit run as normal model turns with the bundled OpenPond Skill Authoring skill. Skills may include SKILL.md plus focused scripts, references, and assets. Use an Agent when the workflow needs code, actions, durable runtime behavior, setup, or Evals.",
    ].join("\n"),
  };
}

function listProfileSkills(profile: OpenPondProfileState): ProfileSkillCommandResult {
  const skills = profile.skills.slice().sort((left, right) => left.name.localeCompare(right.name));
  const message = skills.length === 0
    ? "No profile skills found in the active profile."
    : [
        `Profile skills (${skills.length}):`,
        ...skills.map((skill) => {
          const status = skill.validationStatus === "valid"
            ? "valid"
            : `invalid: ${skill.validationMessages.join("; ")}`;
          return `- ${skill.name} (${status}) ${skill.path}`;
        }),
      ].join("\n");
  return {
    handled: true,
    action: "list",
    message,
    skills,
    profile,
  };
}
