import { describe, expect, test } from "vitest";
import { sessionsWithTasksetNames } from "./session-taskset-names.js";

describe("session Taskset names", () => {
  test("hydrates legacy benchmark session metadata from the Taskset store", async () => {
    const session = {
      id: "benchmark-session",
      metadata: { tasksetId: "benchmark-harness-refiner" },
    };
    const [named] = await sessionsWithTasksetNames([session], async (id) =>
      ({ id, name: "Harness Refiner" })
    );

    expect(named?.metadata).toEqual({
      tasksetId: "benchmark-harness-refiner",
      tasksetName: "Harness Refiner",
    });
  });

  test("preserves a name already recorded on the session", async () => {
    const session = {
      id: "named-session",
      metadata: {
        trainingTasksetId: "support",
        trainingTasksetName: "Support Review",
      },
    };
    const [named] = await sessionsWithTasksetNames([session], async (id) =>
      ({ id, name: "Different store name" })
    );

    expect(named).toBe(session);
  });
});
