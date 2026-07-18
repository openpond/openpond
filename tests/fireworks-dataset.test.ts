import { describe, expect, test } from "vitest";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_DEFINITIONS,
  TasksetSchema,
} from "../packages/contracts/src";
import {
  computeTasksetHash,
  sha256,
} from "../packages/taskset-sdk/src";
import {
  renderFireworksRftDataset,
  renderFireworksSftDataset,
} from "../apps/server/src/training/fireworks-dataset";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("Fireworks SFT dataset rendering", () => {
  test("exports only approved train demonstrations and keeps frozen evaluation private", () => {
    const taskset = tasksetFixture({ ready: true });
    const rendered = renderFireworksSftDataset(taskset);
    const lines = rendered.bytes.toString("utf8").trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      messages: [
        { role: "user", content: "Say hello" },
        { role: "assistant", content: "Hello friend" },
      ],
    });
    expect(rendered.taskIds).toEqual(["task_train"]);
    expect(rendered.contentHash).toBe(sha256(rendered.bytes));
    expect(rendered.bytes.toString("utf8")).not.toContain("Say goodbye");
    expect(rendered.bytes.toString("utf8")).not.toContain("Goodbye friend");
    expect(rendered.bytes.toString("utf8")).not.toContain(taskset.contentHash);
  });

  test("preserves approved structured tool trajectories in OpenAI-compatible messages", () => {
    const base = tasksetFixture({ ready: true });
    const tasks = base.tasks.map((task) =>
      task.id === "task_train"
        ? {
            ...task,
            input: {
              messages: [
                { role: "system", content: "Use the inventory tool." },
                { role: "user", content: "Find item 42." },
              ],
            },
            expectedOutput: {
              messages: [
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_inventory",
                    type: "function",
                    function: { name: "inventory_get", arguments: "{\"id\":\"42\"}" },
                  }],
                },
                {
                  role: "tool",
                  tool_call_id: "call_inventory",
                  content: "{\"id\":\"42\",\"status\":\"ready\"}",
                },
                { role: "assistant", content: "Item 42 is ready." },
              ],
            },
          }
        : task,
    );
    const draft = TasksetSchema.parse({
      ...base,
      environment: {
        ...base.environment,
        metadata: {
          ...base.environment.metadata,
          toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
        },
      },
      metadata: {
        ...base.metadata,
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      },
      tasks,
      readiness: null,
      contentHash: "00000000",
    });
    const taskset = TasksetSchema.parse({
      ...draft,
      contentHash: computeTasksetHash(draft),
    });
    const rendered = renderFireworksSftDataset(taskset);

    expect(JSON.parse(rendered.bytes.toString("utf8"))).toEqual({
      tools: CROSS_SYSTEM_TOOL_DEFINITIONS.map((definition) => ({
        type: "function",
        function: definition,
      })),
      messages: [
        { role: "system", content: "Use the inventory tool." },
        { role: "user", content: "Find item 42." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_inventory",
            type: "function",
            function: { name: "inventory_get", arguments: "{\"id\":\"42\"}" },
          }],
        },
        {
          role: "tool",
          content: "{\"id\":\"42\",\"status\":\"ready\"}",
          tool_call_id: "call_inventory",
        },
        { role: "assistant", content: "Item 42 is ready." },
      ],
    });
  });

  test("rejects Tasksets without an approved train demonstration", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      learningSignals: {
        ...base.learningSignals,
        demonstrations: base.learningSignals.demonstrations.map((item) => ({
          ...item,
          approved: false,
        })),
      },
    });

    expect(() => renderFireworksSftDataset(taskset)).toThrow(
      "at least one approved train-split demonstration",
    );
  });
});

describe("Fireworks RFT dataset rendering", () => {
  test("exports policy-visible train prompts and lineage without private answers or graders", () => {
    const taskset = tasksetFixture({ ready: true });
    const rendered = renderFireworksRftDataset(taskset);
    const record = JSON.parse(rendered.bytes.toString("utf8")) as {
      messages: Array<{ role: string; content: string }>;
      input_metadata: {
        row_id: string;
        dataset_info: Record<string, string>;
      };
    };

    expect(record.messages.at(-1)).toEqual({
      role: "user",
      content: "Say hello",
    });
    expect(record.input_metadata).toMatchObject({
      row_id: "task_train",
      dataset_info: {
        taskset_id: taskset.id,
        taskset_hash: taskset.contentHash,
        task_id: "task_train",
      },
    });
    expect(rendered.taskIds).toEqual(["task_train"]);
    expect(rendered.contentHash).toBe(sha256(rendered.bytes));
    const exported = rendered.bytes.toString("utf8");
    for (const privateValue of [
      "Hello friend",
      "Say goodbye",
      "Goodbye friend",
      "outcome_train",
      "expected_output",
    ]) {
      expect(exported).not.toContain(privateValue);
    }
  });
});
