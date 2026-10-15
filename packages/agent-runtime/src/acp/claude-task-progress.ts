import type { AcpObject } from "./types.js";

const record = (value: unknown): AcpObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as AcpObject) : {};
type Task = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};
const status = (value: unknown): Task["status"] | null =>
  value === "pending" || value === "in_progress" || value === "completed" ? value : null;

/** Written todos are separate from background process liveness. Only successful
 * tool results commit changes; repeated assistant snapshots are idempotent. */
export class ClaudeTaskProgress {
  private calls = new Map<string, { name: string; input: AcpObject }>();
  private tasks = new Map<string, Task>();
  constructor(private readonly emit: (update: AcpObject) => void) {}

  beginTurn(): void {
    this.calls.clear();
  }

  tool(update: AcpObject): void {
    const name = String(update.title);
    if (!["TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"].includes(name)) return;
    this.calls.set(String(update.toolCallId), { name, input: record(update.rawInput) });
  }

  result(block: AcpObject, metadata: unknown): void {
    const callId = String(block.tool_use_id);
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId);
    const output = record(metadata),
      input = call.input;
    if (block.is_error || output.success === false) return;
    if (call.name === "TodoWrite") {
      const todos = Array.isArray(output.newTodos) ? output.newTodos : input.todos;
      if (!Array.isArray(todos)) return;
      const next = new Map<string, Task>();
      for (const [index, value] of todos.entries()) {
        const task = this.parse(value, "content");
        if (!task) return;
        next.set(String(index), task);
      }
      this.tasks = next;
    } else if (call.name === "TaskCreate") {
      const created = record(output.task);
      const task = this.parse(
        { ...input, subject: created.subject ?? input.subject, status: "pending" },
        "subject",
      );
      if (typeof created.id !== "string" || !task) return;
      this.tasks.set(created.id, task);
    } else if (call.name === "TaskUpdate") {
      const id = input.taskId ?? input.id ?? input.task_id;
      if (typeof id !== "string") return;
      if (input.status === "deleted") this.tasks.delete(id);
      else {
        const existing = this.tasks.get(id);
        if (!existing) return;
        const task = this.parse(
          {
            subject: existing.content,
            ...existing,
            ...input,
            activeForm: input.activeForm ?? input.active_form ?? existing.activeForm,
          },
          "subject",
        );
        if (!task) return;
        this.tasks.set(id, task);
      }
    } else if (call.name === "TaskGet") {
      const value = record(output.task),
        task = this.parse(value, "subject");
      if (typeof value.id !== "string" || !task) return;
      this.tasks.set(value.id, task);
    } else {
      if (!Array.isArray(output.tasks)) return;
      const next = new Map<string, Task>();
      for (const value of output.tasks) {
        const item = record(value),
          task = this.parse(item, "subject");
        if (typeof item.id !== "string" || !task) return;
        next.set(item.id, { ...this.tasks.get(item.id), ...task });
      }
      this.tasks = next;
    }
    this.emit({
      sessionUpdate: "plan",
      entries: [...this.tasks.entries()].map(([id, task]) => ({ id, ...task })),
      nativeTaskProgress: true,
    });
  }

  private parse(value: unknown, textKey: string): Task | null {
    const item = record(value),
      state = status(item.status),
      text = item[textKey];
    if (!state || typeof text !== "string" || !text.trim()) return null;
    const activeForm = item.activeForm ?? item.active_form;
    return {
      content: text,
      status: state,
      ...(typeof activeForm === "string" ? { activeForm } : {}),
    };
  }
}
