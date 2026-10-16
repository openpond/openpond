export const MAX_PROJECTED_COMMAND_OUTPUT_CHARS = 64 * 1024;
const PROJECTED_COMMAND_OUTPUT_HEAD_CHARS = 8 * 1024;

export function boundProjectedCommandOutput(value: string): string {
  if (value.length <= MAX_PROJECTED_COMMAND_OUTPUT_CHARS) return value;
  const marker = "\n\n… output omitted from live view; full output remains in task history …\n\n";
  const tailLength = Math.max(
    0,
    MAX_PROJECTED_COMMAND_OUTPUT_CHARS - PROJECTED_COMMAND_OUTPUT_HEAD_CHARS - marker.length,
  );
  return `${value.slice(0, PROJECTED_COMMAND_OUTPUT_HEAD_CHARS)}${marker}${value.slice(-tailLength)}`;
}
