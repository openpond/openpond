import { describe, expect, test } from "bun:test";
import {
  assistantMessageForNativeToolCalls,
  NativeToolCallAccumulator,
} from "../apps/server/src/openpond/native-tool-calls";

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

  test("preserves exact reasoning content on assistant tool-call messages", () => {
    const toolCalls = [
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
        },
      },
    ];
    const reasoningContent = "First inspect README.\nThen decide whether another file is needed.";

    expect(assistantMessageForNativeToolCalls("", toolCalls, { reasoningContent })).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: reasoningContent,
      tool_calls: [toolCalls[0]!.hostedToolCall],
    });
  });
});
