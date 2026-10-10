import type { AcpObject } from "./types.js";

const record = (value: unknown): AcpObject => value && typeof value === "object" && !Array.isArray(value) ? value as AcpObject : {};
const terminal = new Set(["completed", "failed", "stopped", "killed"]);
type Task = { id: string; toolCallId?: string; description?: string; status: string; background: boolean; ambient: boolean; summary?: string };

/** Membership snapshots own liveness; task edges own the originating tool's outcome. */
export class ClaudeBackgroundTasks {
  private live = new Set<string>();
  private tasks = new Map<string, Task>();
  private tools = new Map<string, AcpObject>();
  constructor(private readonly emit: (update: AcpObject) => void) {}

  get running(): boolean { return this.live.size > 0; }
  get ids(): string[] { return [...this.live]; }

  beginTurn(): void { this.tasks.clear(); this.tools.clear(); }

  tool(update: AcpObject): void {
    const id = String(update.toolCallId);
    this.tools.set(id, { ...this.tools.get(id), ...update });
  }

  observe(message: AcpObject): void {
    if (message.type !== "system") return;
    if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      // The level can precede either bookend. Never rebuild it from task edges.
      this.live = new Set(message.tasks.map(record).filter(task => task.ambient !== true && typeof task.task_id === "string").map(task => String(task.task_id)));
      return;
    }
    if (typeof message.task_id !== "string") return;
    const id = message.task_id;
    const previous = this.tasks.get(id);
    if (!["task_started", "task_updated", "task_progress", "task_notification"].includes(String(message.subtype))) return;
    const patch = message.subtype === "task_updated" ? record(message.patch) : message;
    const task: Task = { id, status: "running", background: this.live.has(id), ambient: false, ...previous,
      ...(typeof message.tool_use_id === "string" ? { toolCallId: message.tool_use_id } : {}),
      ...(typeof patch.description === "string" ? { description: patch.description } : {}),
      ...(typeof patch.status === "string" ? { status: patch.status } : {}),
      ...(typeof patch.is_backgrounded === "boolean" ? { background: patch.is_backgrounded } : {}),
      ...(typeof message.ambient === "boolean" ? { ambient: message.ambient } : {}),
      ...(typeof message.summary === "string" ? { summary: message.summary } : typeof patch.error === "string" ? { summary: patch.error } : {}),
    };
    // Duplicate starts/progress must not reopen a terminal command.
    if (previous && terminal.has(previous.status)) task.status = previous.status;
    this.tasks.set(id, task);
    if (previous && JSON.stringify(previous) === JSON.stringify(task)) return;
    this.publish(task);
  }

  result(block: AcpObject, metadata: AcpObject): AcpObject | null {
    const id = typeof metadata.backgroundTaskId === "string" ? metadata.backgroundTaskId : undefined;
    const known = [...this.tasks.values()].find(task => task.toolCallId === block.tool_use_id && task.background);
    if (!id && !known) return null;
    const task: Task = known ?? this.tasks.get(id!) ?? { id: id!, status: "running", background: true, ambient: false };
    task.toolCallId = String(block.tool_use_id);
    this.tasks.set(task.id, task);
    return this.update(task, block.content);
  }

  interrupt(): void {
    for (const task of this.tasks.values()) if (task.background && !terminal.has(task.status)) {
      task.status = "stopped";
      task.summary = "Background task interrupted.";
      this.publish(task);
    }
  }

  private publish(task: Task): void {
    const update = this.update(task, task.summary ?? task.description);
    if (update) this.emit(update);
  }

  private update(task: Task, content: unknown): AcpObject | null {
    if (!task.background || task.ambient || !task.toolCallId) return null;
    const tool = this.tools.get(task.toolCallId) ?? {};
    return { ...tool, sessionUpdate: "tool_call_update", toolCallId: task.toolCallId,
      title: tool.title ?? task.description ?? "Background task",
      status: terminal.has(task.status) ? task.status === "completed" ? "completed" : "failed" : "in_progress",
      nativeBackgroundTask: true, nativeTaskId: task.id, content };
  }
}
