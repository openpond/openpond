import type { OpenPondProfileSkill } from "@openpond/contracts";

export type ActiveProfileSkillInvocationContext = {
  end: number;
  query: string;
  start: number;
};

export function activeProfileSkillInvocationContext(
  input: string,
  cursor: number,
): ActiveProfileSkillInvocationContext | null {
  const beforeCursor = input.slice(0, Math.max(0, Math.min(cursor, input.length)));
  const match = /(?:^|\s)\$([a-zA-Z][a-zA-Z0-9_-]*)?$/.exec(beforeCursor);
  if (!match || typeof match.index !== "number") return null;
  const dollarOffset = match[0].lastIndexOf("$");
  if (dollarOffset < 0) return null;
  return {
    end: beforeCursor.length,
    query: (match[1] ?? "").toLowerCase(),
    start: match.index + dollarOffset,
  };
}

export function profileSkillInvocationText(skill: Pick<OpenPondProfileSkill, "name">): string {
  return `$${skill.name}`;
}

export function replaceActiveProfileSkillInvocation(
  input: string,
  context: ActiveProfileSkillInvocationContext,
  skill: Pick<OpenPondProfileSkill, "name">,
): { cursor: number; value: string } {
  const start = Math.max(0, Math.min(context.start, input.length));
  const end = Math.max(start, Math.min(context.end, input.length));
  const before = input.slice(0, start);
  const after = input.slice(end);
  const leadingSpace = before && !/\s$/.test(before) ? " " : "";
  const trailingSpace = after ? (!/^\s/.test(after) ? " " : "") : " ";
  const replacement = `${leadingSpace}${profileSkillInvocationText(skill)}${trailingSpace}`;

  return {
    cursor: before.length + replacement.length - (after ? trailingSpace.length : 0),
    value: `${before}${replacement}${after}`,
  };
}

export function profileSkillInvocationMatchesForQuery(
  skills: OpenPondProfileSkill[],
  query: string,
  limit?: number,
): OpenPondProfileSkill[] {
  const needle = query.trim().toLowerCase();
  const matches = skills
    .filter((skill) => skill.enabled && skill.validationStatus === "valid")
    .filter((skill) => {
      if (!needle) return true;
      return [skill.name, skill.description, skill.path]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return typeof limit === "number" && Number.isFinite(limit)
    ? matches.slice(0, Math.max(0, limit))
    : matches;
}
