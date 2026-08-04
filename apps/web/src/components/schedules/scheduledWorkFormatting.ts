export function formatScheduledRunAt(
  value: string | null | undefined,
  timeZone: string | null
): string {
  if (!value) return "None";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "None";
  try {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone, timeZoneName: "short" as const } : {}),
    });
  } catch {
    return date.toLocaleString();
  }
}

export function runStatusLabel(value: string): string {
  return capitalize(value.replaceAll("_", " "));
}

export function capitalize(value: string): string {
  return value.replace(/^./, (character) => character.toUpperCase());
}
