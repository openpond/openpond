import { Buffer } from "node:buffer";

export const MAX_GOAL_FILE_READ_BYTES = 1024 * 1024;
export const MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES = 256 * 1024;

export function assertGoalFileReadSize(path: string, size: number): void {
  if (size <= MAX_GOAL_FILE_READ_BYTES) return;
  throw new Error(
    `file is too large to read through goal tools: ${path} (${size} bytes, max ${MAX_GOAL_FILE_READ_BYTES} bytes)`
  );
}

export function truncateGoalTextArtifact(
  content: string,
  maxBytes: number = MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES
): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf-8") <= maxBytes) {
    return { content, truncated: false };
  }
  const marker = `\n[truncated after ${maxBytes} bytes]\n`;
  const bodyBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf-8"));
  return {
    content: `${Buffer.from(content)
      .subarray(0, bodyBytes)
      .toString("utf8")}${marker}`,
    truncated: true,
  };
}
