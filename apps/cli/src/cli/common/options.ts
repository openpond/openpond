export function parseJsonOption(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export function parseJsonObjectOption(
  value: string,
  label: string
): Record<string, unknown> {
  const parsed = parseJsonOption(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function optionString(
  options: Record<string, string | boolean>,
  key: string
): string {
  const value = options[key];
  return typeof value === "string" ? value.trim() : "";
}

export function requiredTeamId(
  options: Record<string, string | boolean>,
  usage: string
): string {
  const teamId = optionString(options, "teamId");
  if (!teamId) {
    throw new Error(`${usage} --team-id <id>`);
  }
  return teamId;
}

export function optionalJsonObject(
  options: Record<string, string | boolean>,
  key: string,
  label: string
): Record<string, unknown> | undefined {
  const value = optionString(options, key);
  return value ? parseJsonObjectOption(value, label) : undefined;
}

export function parseBooleanOption(
  value: string | boolean | undefined
): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return false;
}

export function parseNumberOption(
  value: string | boolean | undefined,
  label: string
): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

export function parseIntegerOption(
  value: string | boolean | undefined,
  label: string
): number | undefined {
  const parsed = parseNumberOption(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

export function parseCsvOption(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseTimeOption(
  value: string | boolean | undefined,
  label: string
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return String(parsed);
  }
  throw new Error(`${label} must be a unix ms timestamp or ISO date`);
}

export function resolveTemplateEnvironment(
  value: string | undefined
): "preview" | "production" {
  if (!value) return "production";
  const normalized = value.toLowerCase();
  if (normalized === "preview" || normalized === "production") {
    return normalized;
  }
  throw new Error("env must be preview or production");
}
