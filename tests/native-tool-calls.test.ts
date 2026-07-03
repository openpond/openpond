import { describe, expect, test } from "bun:test";
import { NativeToolCallAccumulator } from "../apps/server/src/openpond/native-tool-calls";

describe("native tool call accumulator", () => {
  test("accumulates streamed id, name, and argument chunks by index", () => {
    const accumulator = new NativeToolCallAccumulator();

    accumulator.append([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "resource_", arguments: '{"scope":"' },
      } as any,
    ]);
    accumulator.append([
      {
        index: 0,
        type: "function",
        function: { name: "search", arguments: 'workspace","query":"README"}' },
      } as any,
    ]);

    expect(accumulator.completed()).toEqual([
      {
        id: "call_1",
        name: "resource_search",
        argumentsJson: '{"scope":"workspace","query":"README"}',
        hostedToolCall: {
          id: "call_1",
          type: "function",
          function: {
            name: "resource_search",
            arguments: '{"scope":"workspace","query":"README"}',
          },
          index: 0,
        },
      },
    ]);
  });
});
