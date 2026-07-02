import { describe, expect, test } from "bun:test";
import { createBackgroundWorkerQueue } from "../apps/server/src/runtime/background-worker-queue";

describe("background worker queue", () => {
  test("runs jobs serially and drains queued work", async () => {
    const queue = createBackgroundWorkerQueue({ queueId: "turn-follow-up" });
    const order: string[] = [];

    const first = queue.enqueue({ label: "first" }, async () => {
      order.push("first:start");
      await delay(10);
      order.push("first:end");
    });
    const second = queue.enqueue({ label: "second" }, async () => {
      order.push("second:start");
      order.push("second:end");
    });

    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");

    await queue.drain();

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(queue.pendingReceipts()).toEqual([]);
    expect(queue.receipts().map((receipt) => receipt.label)).toEqual(["first", "second"]);
  });

  test("captures failures on receipts without rejecting drain", async () => {
    const warnings: Record<string, unknown>[] = [];
    const queue = createBackgroundWorkerQueue({
      queueId: "provider-runtime-ingestion",
      logger: {
        warn: (_message, fields = {}) => {
          warnings.push(fields);
        },
      },
    });

    const receipt = queue.enqueue({ label: "bad notification" }, async () => {
      throw new Error("provider payload was invalid");
    });

    await expect(queue.drain()).resolves.toBeUndefined();

    expect(receipt.status).toBe("failed");
    expect(receipt.error).toBe("provider payload was invalid");
    expect(warnings[0]).toMatchObject({
      queueId: "provider-runtime-ingestion",
      jobId: receipt.id,
      label: "bad notification",
      error: "provider payload was invalid",
    });
  });
});

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
