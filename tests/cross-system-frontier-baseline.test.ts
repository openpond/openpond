import { describe, expect, test } from "bun:test";
import type { CrossSystemFrontierModelStream } from "../apps/server/src/training/cross-system-operations";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  recordFrontierBaselineSources,
  runFrontierCrossSystemBaseline,
} from "../apps/server/src/training/cross-system-operations";
import { sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("Cross-System Operations frontier baseline", () => {
  test("runs the selected provider through the real bounded tool loop", async () => {
    const world = generateCrossSystemWorld({ seed: 901, split: "train", difficulty: "easy" });
    const tasks = generateCrossSystemTasks(world);
    const expectedByPrompt = new Map(tasks.map((task) => [task.prompt, task.expectedAnswer]));
    const stream: CrossSystemFrontierModelStream = async function* ({ messages, requestId }) {
      expect(requestId.length).toBeLessThanOrEqual(64);
      const prompt = messages.find((message) => message.role === "user")?.content ?? "";
      const toolResult = messages.some((message) => message.role === "tool");
      if (!toolResult) {
        yield {
          toolCalls: [{
            index: 0,
            id: `call_${messages.length}`,
            type: "function",
            function: { name: "search_crm", arguments: JSON.stringify({ query: "*", fields: ["account_id", "name"], cursor: null, limit: 50 }) },
          }],
        };
        return;
      }
      yield { text: `ANSWER: ${JSON.stringify(expectedByPrompt.get(prompt))}` };
    };
    const baseline = await runFrontierCrossSystemBaseline({
      worlds: [world],
      tasks,
      model: { providerId: "openai", modelId: "frontier-test" },
      reasoningEffort: "high",
      stream,
    });
    expect(baseline.report.exactMatchAccuracy).toBe(1);
    expect(baseline.report.metrics.toolCalls).toBe(5);
    expect(baseline.trajectories.every((trajectory) => trajectory.metadata.execution === "provider_tool_loop")).toBe(true);
    expect(baseline.results.every((result) => result.outcome === "correct")).toBe(true);
  });

  test("persists frontier evidence separately from the harness fixture and approves only correct traces", async () => withTrainingStore(async ({ store }) => {
    const specs = [
      { seed: 911, split: "train" as const, difficulty: "easy" as const },
      { seed: 912, split: "validation" as const, difficulty: "medium" as const },
      { seed: 913, split: "frozen_eval" as const, difficulty: "hard" as const },
    ];
    const tasks = specs.flatMap((spec) => generateCrossSystemTasks(generateCrossSystemWorld(spec))).filter((task) => task.phrasingVariant === 0);
    const expectedByPrompt = new Map(tasks.map((task, index) => [task.prompt, index % 3 === 0 ? task.expectedAnswer : {}]));
    const stream: CrossSystemFrontierModelStream = async function* ({ messages }) {
      const prompt = messages.find((message) => message.role === "user")?.content ?? "";
      yield { text: `ANSWER: ${JSON.stringify(expectedByPrompt.get(prompt))}` };
    };
    let sourceOrdinal = 0;
    const baseline = await recordFrontierBaselineSources({
      store,
      profileId: "default",
      worldSpecs: specs,
      model: { providerId: "openai", modelId: "frontier-test" },
      reasoningEffort: null,
      stream,
      createEvidenceSource: async ({ task }) => {
        const source = sourceFixture(`frontier_source_${sourceOrdinal++}`, task.worldId);
        await store.upsertTrainingSource(source);
        return source;
      },
    });
    expect(baseline.report.reward.variance).toBeGreaterThan(0);
    expect(baseline.sources).toHaveLength(15);
    expect(baseline.sources.every((source) => source.metadata.frontierBaseline === true && source.metadata.fixtureBaseline !== true)).toBe(true);
    expect(baseline.bootstrap).toHaveLength(baseline.results.filter((result) => result.outcome === "correct").length);
    expect(baseline.sources.filter((source) => (source.metadata.crossSystemOperations as any).approved === true)).toHaveLength(baseline.bootstrap.length);
  }));
});
