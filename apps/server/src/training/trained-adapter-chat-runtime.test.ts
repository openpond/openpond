import { describe, expect, test, vi } from "vitest";
import { createTrainedAdapterChatRuntime } from "./trained-adapter-chat-runtime.js";

const streamInput = {
  modelId: "binding:profile-1:chat_manual:target-1",
  messages: [{ role: "user" as const, content: "hello" }],
  requestId: "request-1",
  signal: new AbortController().signal,
};

describe("trained adapter chat runtime provider selection", () => {
  test("does not fall through after a managed provider failure", async () => {
    const localStream = vi.fn(async function* () {
      yield { text: "local" };
    });
    const runtime = createTrainedAdapterChatRuntime({
      managed: {
        appliesTo: vi.fn(async () => true),
        stream: vi.fn(async function* () {
          throw new Error("managed_provider_unavailable");
        }),
      },
      local: {
        stream: localStream,
        close: vi.fn(async () => undefined),
      },
    });

    await expect(collect(runtime.stream(streamInput))).rejects.toThrow(
      "managed_provider_unavailable",
    );
    expect(localStream).not.toHaveBeenCalled();
  });

  test("uses local serving when managed does not own the lineage", async () => {
    const localStream = vi.fn(async function* () {
      yield { text: "local" };
    });
    const close = vi.fn(async () => undefined);
    const runtime = createTrainedAdapterChatRuntime({
      managed: {
        appliesTo: vi.fn(async () => false),
        stream: vi.fn(async function* () {
          yield { text: "managed" };
        }),
      },
      local: { stream: localStream, close },
    });

    await expect(collect(runtime.stream(streamInput))).resolves.toEqual([
      { text: "local" },
    ]);
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
