import type { BundledAuthoringSkillName } from "./bundled-authoring-skills.js";

export type AuthoringIntent =
  | {
      artifact: "skill";
      operation: "create" | "edit";
      objective: string;
      targetSkillName: string | null;
      source: "slash_command" | "authoring_entry";
    }
  | {
      artifact: "agent";
      operation: "create" | "improve";
      objective: string;
      targetAgentId: string | null;
      source: "slash_command" | "authoring_entry";
    }
  | {
      artifact: "refiner";
      operation: "update";
      objective: string;
      source: "slash_command";
    };

export type AuthoringCommandRoute = {
  skillName: BundledAuthoringSkillName;
  intent: AuthoringIntent;
};

export function authoringCommandRoute(prompt: string): AuthoringCommandRoute | null {
  return skillAuthoringRoute(prompt) ?? agentAuthoringRoute(prompt) ?? refinerAuthoringRoute(prompt);
}

export function authoringCommandRouteFromLegacyAgentRun(run: {
  operation: string;
  objective: string;
  target: { kind: string; id?: string | null };
}): AuthoringCommandRoute | null {
  if (
    run.target.kind !== "agent" ||
    (run.operation !== "create" && run.operation !== "improve")
  ) return null;
  const targetAgentId = run.operation === "improve"
    ? normalizePackageId(run.target.id ?? "")
    : null;
  if (run.operation === "improve" && !targetAgentId) {
    throw new Error("Agent improve requires an exact target Agent ID.");
  }
  return {
    skillName: "openpond-agent-authoring",
    intent: {
      artifact: "agent",
      operation: run.operation,
      objective: run.objective.trim() || (
        run.operation === "create"
          ? "Create a source-backed Profile Agent."
          : `Improve the Profile Agent ${targetAgentId}.`
      ),
      targetAgentId,
      source: "authoring_entry",
    },
  };
}

function skillAuthoringRoute(prompt: string): AuthoringCommandRoute | null {
  const match = /^\/skill(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!match) return null;
  const rest = match[1]?.trim() ?? "";
  if (!rest) return null;
  const [subcommandRaw = "", ...parts] = rest.split(/\s+/);
  const subcommand = subcommandRaw.toLowerCase();
  if (subcommand === "list" || subcommand === "help") return null;
  if (subcommand === "edit") {
    const [targetRaw = "", ...objectiveParts] = parts;
    const targetSkillName = normalizePackageId(targetRaw.replace(/^\$/, ""));
    if (!targetSkillName) {
      throw new Error("/skill edit requires an exact lowercase kebab-case Skill name.");
    }
    return {
      skillName: "openpond-skill-authoring",
      intent: {
        artifact: "skill",
        operation: "edit",
        objective: objectiveParts.join(" ").trim() || `Improve the Profile skill ${targetRaw || "selected by the user"}.`,
        targetSkillName,
        source: "slash_command",
      },
    };
  }
  const objective = subcommand === "create" ? parts.join(" ").trim() : rest;
  const named = splitOptionalSkillName(objective);
  return {
    skillName: "openpond-skill-authoring",
    intent: {
      artifact: "skill",
      operation: "create",
      objective: named.objective || "Create a reusable Profile skill from the current conversation.",
      targetSkillName: named.name,
      source: "slash_command",
    },
  };
}

function agentAuthoringRoute(prompt: string): AuthoringCommandRoute | null {
  const match = /^\/agent(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!match) return null;
  const rest = match[1]?.trim() ?? "";
  const [subcommandRaw = "", ...parts] = rest.split(/\s+/);
  const subcommand = subcommandRaw.toLowerCase();
  if (subcommand === "help" || subcommand === "list") return null;
  if (subcommand === "improve" || subcommand === "edit") {
    const [targetRaw = "", ...objectiveParts] = parts;
    const targetAgentId = normalizePackageId(targetRaw);
    if (!targetAgentId) {
      throw new Error("/agent improve requires an exact lowercase kebab-case Agent ID.");
    }
    return {
      skillName: "openpond-agent-authoring",
      intent: {
        artifact: "agent",
        operation: "improve",
        objective: objectiveParts.join(" ").trim() || `Improve the Profile Agent ${targetRaw || "selected by the user"}.`,
        targetAgentId,
        source: "slash_command",
      },
    };
  }
  const objective = subcommand === "create" ? parts.join(" ").trim() : rest;
  return {
    skillName: "openpond-agent-authoring",
    intent: {
      artifact: "agent",
      operation: "create",
      objective: objective || "Create a source-backed Profile Agent from the current conversation.",
      targetAgentId: null,
      source: "slash_command",
    },
  };
}

function refinerAuthoringRoute(prompt: string): AuthoringCommandRoute | null {
  const match = /^\/refiner(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!match) return null;
  const objective = match[1]?.trim() ?? "";
  if (!objective || objective === "help") return null;
  return {
    skillName: "openpond-refiner-authoring",
    intent: {
      artifact: "refiner",
      operation: "update",
      objective,
      source: "slash_command",
    },
  };
}

function splitOptionalSkillName(input: string): { name: string | null; objective: string } {
  const trimmed = input.trim();
  const namedFlag = /^--name\s+([a-z][a-z0-9-]*)\s+([\s\S]+)$/i.exec(trimmed);
  if (namedFlag) {
    return {
      name: normalizePackageId(namedFlag[1] ?? ""),
      objective: namedFlag[2]?.trim() ?? "",
    };
  }
  const colon = /^([a-z][a-z0-9-]*):\s*([\s\S]+)$/.exec(trimmed);
  if (colon) {
    return {
      name: normalizePackageId(colon[1] ?? ""),
      objective: colon[2]?.trim() ?? "",
    };
  }
  return { name: null, objective: trimmed };
}

function normalizePackageId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
}
