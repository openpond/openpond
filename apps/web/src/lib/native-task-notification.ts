export type NativeTaskNotification = {
  taskId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  outputFile?: string;
};

/** Recognize only a complete native envelope. Partial/mixed content stays text. */
export function parseNativeTaskNotification(content: string): NativeTaskNotification | null {
  const envelope = /^\s*<task-notification>\s*([\s\S]*?)\s*<\/task-notification>\s*$/.exec(content);
  if (!envelope) return null;
  const fields = new Map<string, string>();
  const pattern = /<(task-id|tool-use-id|output-file|status|summary)>([\s\S]*?)<\/\1>/g;
  let end = 0;
  for (const match of envelope[1]!.matchAll(pattern)) {
    if (envelope[1]!.slice(end, match.index).trim() || fields.has(match[1]!)) return null;
    fields.set(match[1]!, match[2]!.trim());
    end = match.index! + match[0].length;
  }
  if (envelope[1]!.slice(end).trim()) return null;
  const taskId = fields.get("task-id"),
    summary = fields.get("summary"),
    status = fields.get("status");
  if (!taskId || !summary || !["completed", "failed", "stopped"].includes(status ?? ""))
    return null;
  const outputFile = fields.get("output-file");
  return {
    taskId,
    summary,
    status: status as NativeTaskNotification["status"],
    ...(outputFile?.startsWith("/") && !/[\0\r\n]/.test(outputFile) ? { outputFile } : {}),
  };
}
