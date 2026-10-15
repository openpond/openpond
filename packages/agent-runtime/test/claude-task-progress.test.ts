import { expect, it } from "vitest";
import { ClaudeTaskProgress } from "../src/acp/claude-task-progress.js";
import type { AcpObject } from "../src/acp/types.js";

// Failed/repeated calls and task IDs assigned by Claude must never produce
// fictional progress or overwrite another task. Exercise the full lifecycle.
it("commits task progress from successful correlated results and reconciles snapshots", () => {
  const updates: AcpObject[] = [];
  const tracker = new ClaudeTaskProgress((update) => updates.push(update));
  const tool = (id: string, name: string, input: AcpObject) =>
    tracker.tool({ toolCallId: id, title: name, rawInput: input });
  const result = (id: string, output: unknown = {}, is_error = false) =>
    tracker.result({ tool_use_id: id, is_error }, output);
  tool("bad", "TaskCreate", { subject: "Failed creation" });
  result("bad", {}, true);
  expect(updates).toEqual([]);
  tool("create", "TaskCreate", { subject: "Implement", activeForm: "Implementing" });
  tool("create", "TaskCreate", { subject: "Implement", activeForm: "Implementing" });
  result("create", { task: { id: "7", subject: "Implement" } });
  result("create", { task: { id: "8" } });
  expect(updates).toHaveLength(1);
  expect(updates[0]!.entries).toEqual([
    { id: "7", content: "Implement", status: "pending", activeForm: "Implementing" },
  ]);
  tracker.beginTurn();
  tool("failed-update", "TaskUpdate", { taskId: "7", status: "completed" });
  result("failed-update", { success: false });
  expect(updates).toHaveLength(1);
  tool("update", "TaskUpdate", {
    task_id: "7",
    status: "in_progress",
    active_form: "Checking the implementation",
  });
  result("update", { success: true });
  expect(updates[1]!.entries).toEqual([
    {
      id: "7",
      content: "Implement",
      status: "in_progress",
      activeForm: "Checking the implementation",
    },
  ]);
  tool("list", "TaskList", {});
  result("list", {
    tasks: [
      { id: "7", subject: "Implement", status: "completed" },
      { id: "9", subject: "Review", status: "pending" },
    ],
  });
  expect(updates[2]!.entries).toHaveLength(2);
  tool("delete", "TaskUpdate", { id: "7", status: "deleted" });
  result("delete", { success: true });
  expect(updates[3]!.entries).toEqual([{ id: "9", content: "Review", status: "pending" }]);
  tool("todos", "TodoWrite", { todos: [] });
  result("todos", {
    newTodos: [{ content: "Check", status: "in_progress", activeForm: "Checking" }],
  });
  expect(updates[4]!.entries).toEqual([
    { id: "0", content: "Check", status: "in_progress", activeForm: "Checking" },
  ]);
  tool("clear", "TodoWrite", { todos: [] });
  result("clear");
  expect(updates[5]!.entries).toEqual([]);
});
