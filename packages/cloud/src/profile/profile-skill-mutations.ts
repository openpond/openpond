import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  OpenPondProfileSkill,
  OpenPondProfileState,
} from "./local-profile-types.js";
import { loadOpenPondProfileState } from "./local-profile.js";
import {
  PROFILE_SKILL_FILE,
  PROFILE_SKILLS_DIR,
} from "./profile-skills.js";

export type ProfileSkillGoalRequest = {
  id: string;
  kind: "profile_skill_create" | "profile_skill_edit";
  provider: "openpond";
  status: "queued";
  operation: "create" | "edit";
  objective: string;
  source: "slash_command" | "natural_language" | "model_tool";
  activeProfile: string;
  profileRepoPath: string;
  profileSourcePath: string;
  profileSourceRelativePath: string;
  requestedName: string | null;
  targetSkillName: string | null;
  targetSkillPath: string | null;
};

export type ProfileSkillCommandResult = {
  handled: true;
  action: "list" | "help";
  message: string;
  skills?: OpenPondProfileSkill[];
  profile: OpenPondProfileState;
} | {
  handled: false;
  action: "goal";
  message: string;
  prompt: string;
  workspaceCwd: string;
  goal: ProfileSkillGoalRequest;
  skill?: OpenPondProfileSkill;
  profile: OpenPondProfileState;
};

type ProfileSkillCommandDeps = {
  loadProfileState: () => Promise<OpenPondProfileState>;
};

export type ProfileSkillGoalCommandInput = {
  operation: "create" | "edit";
  objective: string;
  skillName?: string | null;
  changeRequest?: string | null;
  source?: "natural_language" | "model_tool" | "slash_command" | null;
};

type ParsedProfileSkillCommand =
  | { action: "list" }
  | { action: "help" }
  | { action: "create"; objective: string; requestedName: string | null }
  | { action: "edit"; name: string; changeRequest: string };

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
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  const parsed = parseProfileSkillCommand(trimmed);
  if (!parsed) return null;
  const profile = await deps.loadProfileState();
  if (parsed.action === "help") return profileSkillHelp(profile);
  if (parsed.action === "list") return listProfileSkills(profile);
  const writableProfile = assertWritableProfile(profile);
  if (parsed.action === "create") {
    return createProfileSkillGoal({
      profile: writableProfile,
      objective: parsed.objective,
      requestedName: parsed.requestedName,
      source: "slash_command",
    });
  }
  return updateProfileSkillGoal({
    profile: writableProfile,
    name: parsed.name,
    changeRequest: parsed.changeRequest,
    source: "slash_command",
  });
}

export async function runProfileSkillGoalCommand(
  input: ProfileSkillGoalCommandInput,
  deps: ProfileSkillCommandDeps = { loadProfileState: loadOpenPondProfileState },
): Promise<ProfileSkillCommandResult> {
  const profile = await deps.loadProfileState();
  const writableProfile = assertWritableProfile(profile);
  const source = input.source ?? "model_tool";
  if (input.operation === "create") {
    return createProfileSkillGoal({
      profile: writableProfile,
      objective: input.objective,
      requestedName: input.skillName ?? null,
      source,
    });
  }
  const name = input.skillName?.trim() ?? "";
  if (!name) throw new Error("Profile skill edit requires skillName.");
  return updateProfileSkillGoal({
    profile: writableProfile,
    name,
    changeRequest: input.changeRequest?.trim() || input.objective,
    source,
  });
}

function parseProfileSkillCommand(
  prompt: string,
): ParsedProfileSkillCommand | null {
  const slash = /^\/skill(?:\s+([\s\S]*))?$/i.exec(prompt);
  if (slash) {
    const rest = slash[1]?.trim() ?? "";
    if (!rest) return { action: "list" };
    const [subcommandRaw = "", ...restParts] = rest.split(/\s+/);
    const subcommand = subcommandRaw.toLowerCase();
    const args = restParts.join(" ").trim();
    if (subcommand === "list") return { action: "list" };
    if (subcommand === "help") return { action: "help" };
    if (subcommand === "create") {
      if (!args) return { action: "help" };
      const named = splitOptionalSkillName(args);
      return {
        action: "create",
        objective: named.objective,
        requestedName: named.name,
      };
    }
    if (subcommand === "edit") {
      const [nameRaw = "", ...changeParts] = args.split(/\s+/);
      const name = normalizeSkillName(nameRaw.replace(/^\$/, ""));
      const changeRequest = changeParts.join(" ").trim();
      if (!name || !changeRequest) return { action: "help" };
      return { action: "edit", name, changeRequest };
    }
    return { action: "help" };
  }
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
      "- /skill create <optional-name> <what the skill should help with>",
      "- /skill edit <skill-name> <change request>",
      "",
      "Create/edit starts a profile-skill goal in the active profile repo. Skills are single-file profile instructions. If the workflow needs scripts, references, tools, or assets, create an agent instead.",
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
          const status = skill.validationStatus === "valid" ? "valid" : `invalid: ${skill.validationMessages.join("; ")}`;
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

function createProfileSkillGoal(input: {
  profile: WritableProfileState;
  objective: string;
  requestedName: string | null;
  source: ProfileSkillGoalRequest["source"];
}): ProfileSkillCommandResult {
  const objective = cleanObjective(input.objective);
  if (!objective) throw new Error("Describe what the skill should help with.");
  const existingNames = new Set(input.profile.skills.map((skill) => skill.name));
  const requestedName = input.requestedName
    ? requireAvailableSkillName(input.requestedName, existingNames, input.profile.sourcePath)
    : null;
  const goal = createProfileSkillGoalRequest({
    profile: input.profile,
    operation: "create",
    objective: `Create a profile-backed skill${requestedName ? ` named ${requestedName}` : ""}: ${objective}`,
    requestedName,
    targetSkillName: requestedName,
    source: input.source,
  });
  return {
    handled: false,
    action: "goal",
    profile: input.profile,
    workspaceCwd: input.profile.repoPath,
    goal,
    prompt: profileSkillGoalPrompt(goal),
    message: `Started profile skill goal: ${goal.objective}`,
  };
}

function updateProfileSkillGoal(input: {
  profile: WritableProfileState;
  name: string;
  changeRequest: string;
  source: ProfileSkillGoalRequest["source"];
}): ProfileSkillCommandResult {
  const name = normalizeSkillName(input.name);
  if (!name) throw new Error("Skill name must be lowercase kebab-case.");
  const existing = input.profile.skills.find((skill) => skill.name === name);
  if (!existing) throw new Error(`Profile skill not found: ${name}`);
  const changeRequest = cleanObjective(input.changeRequest);
  if (!changeRequest) throw new Error("Describe how to update the skill.");
  const goal = createProfileSkillGoalRequest({
    profile: input.profile,
    operation: "edit",
    objective: `Update profile-backed skill ${name}: ${changeRequest}`,
    requestedName: name,
    targetSkillName: name,
    source: input.source,
  });
  return {
    handled: false,
    action: "goal",
    profile: input.profile,
    workspaceCwd: input.profile.repoPath,
    goal,
    skill: existing,
    prompt: profileSkillGoalPrompt(goal),
    message: `Started profile skill goal: ${goal.objective}`,
  };
}

type WritableProfileState = OpenPondProfileState & {
  mode: "local";
  sourcePath: string;
  repoPath: string;
};

function assertWritableProfile(profile: OpenPondProfileState): WritableProfileState {
  if (profile.error) throw new Error(profile.error);
  if (profile.mode !== "local" || !profile.sourcePath || !profile.repoPath) {
    throw new Error("Profile skill creation requires an active local OpenPond profile.");
  }
  return profile as WritableProfileState;
}

function createProfileSkillGoalRequest(input: {
  profile: WritableProfileState;
  operation: "create" | "edit";
  objective: string;
  requestedName: string | null;
  targetSkillName: string | null;
  source: ProfileSkillGoalRequest["source"];
}): ProfileSkillGoalRequest {
  const profileSourceRelativePath = path.relative(input.profile.repoPath, input.profile.sourcePath) || ".";
  const targetSkillPath = input.targetSkillName
    ? path.join(profileSourceRelativePath, PROFILE_SKILLS_DIR, input.targetSkillName, PROFILE_SKILL_FILE).replace(/\\/g, "/")
    : null;
  return {
    id: `goal_${randomUUID()}`,
    kind: input.operation === "create" ? "profile_skill_create" : "profile_skill_edit",
    provider: "openpond",
    status: "queued",
    operation: input.operation,
    objective: input.objective,
    source: input.source,
    activeProfile: input.profile.activeProfile ?? "default",
    profileRepoPath: input.profile.repoPath,
    profileSourcePath: input.profile.sourcePath,
    profileSourceRelativePath: profileSourceRelativePath.replace(/\\/g, "/"),
    requestedName: input.requestedName,
    targetSkillName: input.targetSkillName,
    targetSkillPath,
  };
}

function profileSkillGoalPrompt(goal: ProfileSkillGoalRequest): string {
  const targetPath = goal.targetSkillPath
    ?? `${goal.profileSourceRelativePath}/${PROFILE_SKILLS_DIR}/<skill-name>/${PROFILE_SKILL_FILE}`;
  const nameLine = goal.targetSkillName
    ? `- Skill name: ${goal.targetSkillName}`
    : "- Choose a concise lowercase kebab-case skill name from the user's objective.";
  const modeLine = goal.operation === "edit"
    ? "- Read the existing SKILL.md before changing it."
    : "- Create a new skill directory and SKILL.md.";
  return [
    `Goal: ${goal.objective}`,
    "",
    "<profile_skill_goal>",
    `Operation: ${goal.operation}`,
    `Active profile: ${goal.activeProfile}`,
    `Workspace cwd: profile repo root (${goal.profileRepoPath})`,
    `Profile source: ${goal.profileSourceRelativePath}`,
    nameLine,
    `- Target path: ${targetPath}`,
    "",
    "Rules:",
    modeLine,
    "- Keep the skill package single-file: only SKILL.md.",
    "- SKILL.md must include YAML frontmatter with required name and description fields, followed by a markdown body.",
    "- The body should describe the reusable workflow clearly enough for future chats to apply it.",
    "- Do not add references, scripts, assets, tool dependencies, or setup files. If those are needed, explain that this should be an agent instead.",
    "- Validate the resulting file by reading it back and checking name, description, body, and path consistency.",
    "- Report the final skill name, path, validation status, and explicit invocation such as $skill-name only after the file is written or updated.",
    "- Ask only for missing details that materially change the skill.",
    "</profile_skill_goal>",
  ].join("\n");
}

function splitOptionalSkillName(input: string): { name: string | null; objective: string } {
  const colon = /^([a-z][a-z0-9-]*):\s*([\s\S]+)$/.exec(input.trim());
  if (colon) {
    return {
      name: normalizeSkillName(colon[1] ?? ""),
      objective: colon[2]?.trim() ?? "",
    };
  }
  const [first = "", ...rest] = input.trim().split(/\s+/);
  const normalized = normalizeSkillName(first);
  const objective = rest.join(" ").trim();
  if (normalized && objective.length >= 8) return { name: normalized, objective };
  return { name: null, objective: input.trim() };
}

function requireAvailableSkillName(name: string, existingNames: Set<string>, profileSourcePath: string): string {
  const normalized = normalizeSkillName(name);
  if (!normalized) throw new Error("Skill name must be lowercase kebab-case.");
  if (existingNames.has(normalized) || skillDirectoryExists(profileSourcePath, normalized)) {
    throw new Error(`Profile skill ${normalized} already exists. Use /skill edit ${normalized} to update it.`);
  }
  return normalized;
}

function skillDirectoryExists(profileSourcePath: string, name: string): boolean {
  return existsSync(path.join(profileSourcePath, PROFILE_SKILLS_DIR, name));
}

function cleanObjective(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSkillName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
}
