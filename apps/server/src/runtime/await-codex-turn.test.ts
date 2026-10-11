import { expect, test, vi } from "vitest";
import { awaitCodexTurn } from "./await-codex-turn.js";

// Failure story: a shorter provider default can fail a valid evaluation while
// its native process keeps producing evidence after the app seals the result.
test("native evaluation honors the owner timeout and settles failure before retention", async () => {
  vi.useFakeTimers();
  try {
    const order: string[] = [];
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    const waitForTurn = vi.fn((_id: string, timeoutMs = 600_000) =>
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("native timed out")), timeoutMs)));
    const stopAndWait = vi.fn(async () => { order.push("stop"); await exit; order.push("exit"); });
    const work = awaitCodexTurn({ client: { waitForTurn, stopAndWait }, turnId: "owned-turn",
      timeoutMs: 900_000, signal: new AbortController().signal, flush: async () => { order.push("flush"); } });
    const failed = expect(work).rejects.toThrow("native timed out");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stopAndWait).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(order).toEqual(["stop"]);
    release();
    await failed;
    expect(order).toEqual(["stop", "exit", "flush"]);
    expect(waitForTurn).toHaveBeenCalledWith("owned-turn", 900_000);
  } finally { vi.useRealTimers(); }
});

test("native cancellation waits for cleanup and cannot hide unconfirmed exit or lost evidence", async () => {
  const controller = new AbortController();
  const fallback = vi.fn(async () => {});
  const stop = vi.fn(async () => { throw new Error("exit unconfirmed"); });
  const flush = vi.fn(async () => { throw new Error("evidence unavailable"); });
  const work = awaitCodexTurn({ client: { waitForTurn: () => new Promise(() => {}), stopAndWait: fallback },
    turnId: "owned-turn", signal: controller.signal, stop, flush });
  const failed = expect(work).rejects.toThrow("exit unconfirmed; evidence unavailable");
  controller.abort(new Error("cancelled"));
  await failed;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(fallback).not.toHaveBeenCalled();
});
