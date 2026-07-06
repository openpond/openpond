import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PROFILE_SKILL_FILE,
  PROFILE_SKILLS_DIR,
  loadProfileSkills,
  parseProfileSkillMarkdown,
} from "./profile-skills.js";
import type { ProfileSkillGoalRequest } from "./profile-skill-mutations.js";

export type ExecutedProfileSkillGoal = Omit<
  ProfileSkillGoalRequest,
  "status" | "targetSkillName" | "targetSkillPath"
> & {
  status: "completed";
  targetSkillName: string;
  targetSkillPath: string;
};

export type ProfileSkillGoalExecutionResult = {
  goal: ExecutedProfileSkillGoal;
  skillName: string;
  skillPath: string;
  invocation: string;
  validationStatus: "valid" | "error";
  validationMessages: string[];
  message: string;
};

export async function executeProfileSkillGoalRequest(
  goal: ProfileSkillGoalRequest,
): Promise<ProfileSkillGoalExecutionResult> {
  if (goal.operation === "edit") return executeProfileSkillEdit(goal);
  return executeProfileSkillCreate(goal);
}

async function executeProfileSkillCreate(
  goal: ProfileSkillGoalRequest,
): Promise<ProfileSkillGoalExecutionResult> {
  const existing = await loadProfileSkills(goal.profileSourcePath);
  const existingNames = new Set(existing.skills.map((skill) => skill.name));
  const skillName = uniqueSkillName(
    goal.targetSkillName ?? goal.requestedName ?? inferSkillName(goal.userObjective),
    existingNames,
    goal.profileSourcePath,
  );
  const skillPath = profileSkillPath(skillName);
  const absolutePath = path.join(goal.profileSourcePath, skillPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    renderSkillMarkdown({
      name: skillName,
      description: descriptionForObjective(goal.userObjective),
      body: bodyForObjective(goal.userObjective),
    }),
    "utf8",
  );
  return validateExecutedGoal(goal, skillName);
}

async function executeProfileSkillEdit(
  goal: ProfileSkillGoalRequest,
): Promise<ProfileSkillGoalExecutionResult> {
  const skillName = goal.targetSkillName ?? goal.requestedName;
  if (!skillName) throw new Error("Profile skill edit requires skillName.");
  const skillPath = profileSkillPath(skillName);
  const absolutePath = path.join(goal.profileSourcePath, skillPath);
  if (!existsSync(absolutePath)) throw new Error(`Profile skill not found: ${skillName}`);
  const current = await readFile(absolutePath, "utf8");
  const parsed = parseProfileSkillMarkdown(current);
  if (parsed.messages.length > 0 || !parsed.name || !parsed.description) {
    throw new Error(`Profile skill ${skillName} is not valid. ${parsed.messages.join(" ")}`);
  }
  const change = goal.userObjective.trim();
  const body = [
    parsed.body.trim(),
    "",
    "## Updates",
    "",
    change,
    "",
  ].join("\n");
  await writeFile(
    absolutePath,
    renderSkillMarkdown({
      name: parsed.name,
      description: parsed.description,
      body,
    }),
    "utf8",
  );
  return validateExecutedGoal(goal, skillName);
}

async function validateExecutedGoal(
  goal: ProfileSkillGoalRequest,
  skillName: string,
): Promise<ProfileSkillGoalExecutionResult> {
  const loaded = await loadProfileSkills(goal.profileSourcePath);
  const skill = loaded.skills.find((candidate) => candidate.name === skillName);
  if (!skill) throw new Error(`Profile skill ${skillName} was not discovered after write.`);
  const executedGoal: ExecutedProfileSkillGoal = {
    ...goal,
    status: "completed",
    targetSkillName: skillName,
    targetSkillPath: path.join(
      goal.profileSourceRelativePath,
      PROFILE_SKILLS_DIR,
      skillName,
      PROFILE_SKILL_FILE,
    ).replace(/\\/g, "/"),
  };
  const validationStatus = skill.validationStatus === "valid" ? "valid" : "error";
  if (validationStatus !== "valid") {
    const details = skill.validationMessages.length > 0
      ? skill.validationMessages.join("; ")
      : "unknown validation error";
    throw new Error(`Profile skill ${skillName} validation failed: ${details}`);
  }
  const invocation = `$${skillName}`;
  return {
    goal: executedGoal,
    skillName,
    skillPath: skill.path,
    invocation,
    validationStatus,
    validationMessages: skill.validationMessages,
    message: validationStatus === "valid"
      ? `Created profile skill ${skillName} at ${skill.path}. Invoke it with ${invocation}.`
      : `Profile skill ${skillName} was written but validation failed: ${skill.validationMessages.join("; ")}`,
  };
}

function renderSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
}): string {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

function descriptionForObjective(objective: string): string {
  if (isDockerCleanupObjective(objective)) {
    return "Clean up Docker build cache and unused images while leaving containers and volumes alone. Use when the user asks to inspect Docker disk usage and prune cache/images safely.";
  }
  const singleLine = objective.replace(/\s+/g, " ").trim();
  const trimmed = singleLine.length > 180 ? `${singleLine.slice(0, 177).trimEnd()}...` : singleLine;
  return `Reusable profile workflow for: ${trimmed}`;
}

function bodyForObjective(objective: string): string {
  if (isDockerCleanupObjective(objective)) {
    const dockerCommands = dockerCleanupCommands(objective);
    return [
      "# Docker Cleanup Workflow",
      "",
      "Use this workflow when the user asks to clear Docker build cache and unused images while leaving containers and volumes alone.",
      "",
      "Run these commands in order:",
      "",
      "```bash",
      ...dockerCommands,
      "```",
      "",
      "Notes:",
      "",
      "- `docker builder prune -af` clears build cache.",
      "- `docker image prune -af` removes unused images.",
      "- These commands do not remove Docker volumes.",
      "- These commands do not stop or remove running containers.",
      "- The first `docker system df` captures the before state; the final `docker system df` captures the after state.",
    ].join("\n");
  }
  return [
    "# Workflow",
    "",
    "Follow this reusable workflow when the user request matches the skill description.",
    "",
    "User-provided objective:",
    "",
    objective.trim(),
    "",
    "Steps:",
    "",
    "1. Confirm the request matches this skill's purpose.",
    "2. Apply the workflow described by the objective.",
    "3. Preserve any explicit commands, constraints, or safety notes from the user's request.",
    "4. Report the result clearly and mention any relevant validation or follow-up actions.",
  ].join("\n");
}

function dockerCleanupCommands(objective: string): string[] {
  const matches = objective.matchAll(
    /docker\s+(?:system\s+df|builder\s+prune\s+-af(?:\s*\|\s*tail\s+-n\s+1)?|image\s+prune\s+-af(?:\s*\|\s*tail\s+-n\s+1)?)/gi,
  );
  const commands = [...matches].map((match) => normalizeCommand(match[0] ?? "")).filter(Boolean);
  const systemDfCount = commands.filter((command) => command === "docker system df").length;
  const builderTail = commands.find((command) => command === "docker builder prune -af | tail -n 1");
  const imageTail = commands.find((command) => command === "docker image prune -af | tail -n 1");
  if (systemDfCount >= 2 && builderTail && imageTail) return DOCKER_CLEANUP_COMMANDS;
  if (commands.length === 0) return DOCKER_CLEANUP_COMMANDS;

  const builder = builderTail ?? commands.find((command) => command === "docker builder prune -af");
  const image = imageTail ?? commands.find((command) => command === "docker image prune -af");
  if (builder && image) {
    return [
      ...(systemDfCount > 0 ? ["docker system df"] : []),
      builder,
      image,
      ...(systemDfCount > 1 ? ["docker system df"] : []),
    ];
  }

  const seen = new Set<string>();
  const uniqueCommands: string[] = [];
  let retainedSystemDf = 0;
  for (const command of commands) {
    if (command === "docker system df") {
      if (retainedSystemDf < 2) uniqueCommands.push(command);
      retainedSystemDf += 1;
      continue;
    }
    if (seen.has(command)) continue;
    seen.add(command);
    uniqueCommands.push(command);
  }
  return uniqueCommands;
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").replace(/\s*\|\s*/g, " | ").trim().toLowerCase();
}

function inferSkillName(objective: string): string {
  if (isDockerCleanupObjective(objective)) return "docker-cleanup";
  const tokens = objective
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => !SKILL_NAME_STOP_WORDS.has(token)) ?? [];
  const selected = tokens.slice(0, 4);
  const candidate = selected.join("-");
  return normalizeSkillName(candidate) ?? "profile-skill";
}

function isDockerCleanupObjective(objective: string): boolean {
  const normalized = objective.toLowerCase();
  return normalized.includes("docker") &&
    (normalized.includes("builder prune") ||
      normalized.includes("image prune") ||
      normalized.includes("build cache") ||
      normalized.includes("unused images"));
}

function uniqueSkillName(baseName: string, existingNames: Set<string>, profileSourcePath: string): string {
  const base = normalizeSkillName(baseName) ?? "profile-skill";
  let candidate = base;
  let suffix = 2;
  while (
    existingNames.has(candidate) ||
    existsSync(path.join(profileSourcePath, PROFILE_SKILLS_DIR, candidate))
  ) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function profileSkillPath(skillName: string): string {
  return path.join(PROFILE_SKILLS_DIR, skillName, PROFILE_SKILL_FILE).replace(/\\/g, "/");
}

function normalizeSkillName(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized)) return null;
  return normalized;
}

const SKILL_NAME_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "create",
  "creates",
  "creating",
  "do",
  "for",
  "help",
  "helps",
  "me",
  "new",
  "or",
  "profile",
  "skill",
  "that",
  "the",
  "this",
  "to",
  "use",
  "workflow",
  "with",
  "write",
]);

const DOCKER_CLEANUP_COMMANDS = [
  "docker system df",
  "docker builder prune -af | tail -n 1",
  "docker image prune -af | tail -n 1",
  "docker system df",
];
