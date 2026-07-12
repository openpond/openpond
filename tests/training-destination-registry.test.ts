import { describe, expect, test } from "bun:test";
import { OpenPondManagedTrainingClient, TrainingDestinationRegistry, runDestinationConformance } from "../packages/training-sdk/src";
import { createImmediateCustomExample, ExportTrainingDestination } from "../apps/server/src/training/destinations";
import { planFixture, tasksetFixture } from "./helpers/training-fixtures";

describe("training destination registry", () => {
  test("registers parallel capability-negotiated destinations and rejects duplicates", async () => {
    const taskset = tasksetFixture({ ready: true });
    const registry = new TrainingDestinationRegistry();
    const exportDestination = new ExportTrainingDestination(async () => taskset);
    const custom = createImmediateCustomExample({ resolveTaskset: async () => taskset });
    registry.register(exportDestination);
    registry.register(custom);
    expect(registry.list().map((item) => item.id)).toEqual(["export", "custom"]);
    expect((await exportDestination.validate(planFixture(taskset, "export"))).compatible).toBe(true);
    expect((await runDestinationConformance(custom)).passed).toBe(true);
    expect(() => registry.register(custom)).toThrow("already registered");
  });

  test("keeps the managed client disabled until explicit account configuration", async () => {
    let requests = 0;
    const client = new OpenPondManagedTrainingClient({ config: { schemaVersion: "openpond.managedTrainingClient.v1", endpoint: "https://managed.invalid", accountId: null, enabled: false }, authToken: async () => "token", fetch: async () => { requests += 1; return new Response("{}"); } });
    await expect(client.execution("execution_1")).rejects.toThrow("not enabled");
    expect(requests).toBe(0);
  });
});
