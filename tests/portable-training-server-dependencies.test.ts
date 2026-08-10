import {
  TrainingAdapterRegistry,
  type TrainingEngineAdapter,
} from "@openpond/training-sdk";
import { describe, expect, test, vi } from "vitest";

import { createPortableTrainingServerDependencies } from "../apps/server/src/training/portable-training-server-dependencies.js";

describe("portable training server composition", () => {
  test("does not register desktop compute or engine adapters", async () => {
    const registry = new TrainingAdapterRegistry();
    const dependencies = createPortableTrainingServerDependencies({
      storeDir: "/tmp/openpond-portable-training-test",
      environment: {},
    });

    dependencies.registerPortableAdapters(registry);

    expect(registry.computeTargetIds()).toEqual([]);
    expect(registry.engineIds()).toEqual([]);
  });

  test("composes injected compute and routed engine packages", async () => {
    const registry = new TrainingAdapterRegistry();
    const engine = {
      id: "remote-transport",
      capabilities: vi.fn(),
      validate: vi.fn(),
      launch: vi.fn(),
      consumeSignals: vi.fn(),
      status: vi.fn(),
      logs: vi.fn(),
      cancel: vi.fn(),
      collect: vi.fn(),
    } satisfies TrainingEngineAdapter;
    const dependencies = createPortableTrainingServerDependencies({
      storeDir: "/tmp/openpond-portable-training-test",
      environment: {},
      adapters: {
        engineRoutes: [
          {
            canonicalEngineId: "remote-training",
            route: {
              id: "remote",
              matches: () => true,
              adapter: engine,
            },
          },
        ],
      },
    });

    dependencies.registerPortableAdapters(registry);

    expect(registry.engineIds()).toEqual(["remote-training"]);
  });

  test("does not interpret raw cloud credentials in the desktop process", () => {
    const registry = new TrainingAdapterRegistry();
    const dependencies = createPortableTrainingServerDependencies({
      storeDir: "/tmp/openpond-portable-training-test",
      environment: {
      },
    });
    dependencies.registerPortableAdapters(registry);
    expect(registry.computeTargetIds()).toEqual([]);
    expect(registry.engineIds()).toEqual([]);
  });
});
