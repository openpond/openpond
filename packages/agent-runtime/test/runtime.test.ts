import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  canonicalHash,
  createAgentToolCatalog,
  executeAgentTool,
  materializeAgentPrompt,
  providerRoundSequence
} from "../src/index.js";

describe("@openpond/agent-runtime", () => {
  test("hashes recursively sorted JSON deterministically", () => {
    expect(canonicalHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("derives model tools, execution, UI capabilities, and one catalog hash", async () => {
    const execute = vi.fn(async (input: { path: string }) => `read:${input.path}`);
    const catalog = createAgentToolCatalog([
      {
        name: "read_file",
        description: "Read one file",
        displayLabel: "Read file",
        placement: "local",
        inputSchema: z.object({ path: z.string() }),
        execute
      },
      {
        name: "connected_app",
        description: "Call a connected app",
        placement: "managed",
        inputSchema: z.object({}),
        unavailableReason: "not authorized"
      }
    ]);
    expect(catalog.modelTools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(catalog.capabilities).toEqual([
      expect.objectContaining({ name: "connected_app", available: false }),
      expect.objectContaining({ name: "read_file", available: true })
    ]);
    expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/);
    const signal = new AbortController().signal;
    await expect(executeAgentTool(catalog, {
      name: "read_file",
      arguments: { path: "README.md" },
      context: { threadId: "thread", turnId: "turn", callId: "call", signal }
    })).resolves.toBe("read:README.md");
    expect(execute).toHaveBeenCalledOnce();
  });

  test("owns provider round identity and interruption boundaries", async () => {
    const controller = new AbortController();
    const rounds = providerRoundSequence({ turnId: "turn-1", maxRounds: 3, signal: controller.signal });
    await expect(rounds.next()).resolves.toEqual({
      done: false,
      value: { index: 0, requestId: "turn-1:model:0", signal: controller.signal }
    });
    controller.abort(new Error("stop"));
    await expect(rounds.next()).rejects.toThrow("stop");
  });

  test("materializes prompt layers in canonical order", () => {
    expect(materializeAgentPrompt({
      system: "system",
      harnessInstructions: ["harness"],
      skillInstructions: ["skill"],
      hostInstructions: ["host"]
    })).toBe("system\n\nharness\n\nskill\n\nhost");
  });
});
