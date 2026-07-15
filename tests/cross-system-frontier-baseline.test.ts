import { describe, expect, test } from "bun:test";
import type { CrossSystemFrontierBaselineRun, Session } from "../packages/contracts/src";
import type { CrossSystemFrontierModelStream } from "../apps/server/src/training/cross-system-operations";
import {
  createCrossSystemFrontierBaselineService,
  createFrontierBaselineChatSource,
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  recordFrontierBaselineSources,
  runFrontierCrossSystemBaseline,
} from "../apps/server/src/training/cross-system-operations";
import { FIXED_TIME, seedConversation, sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

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

  test("creates every frontier evidence chat inside the selected local project", async () => withTrainingStore(async ({ store }) => {
    const world = generateCrossSystemWorld({ seed: 921, split: "train", difficulty: "easy" });
    const task = generateCrossSystemTasks(world).find((candidate) => candidate.phrasingVariant === 0)!;
    const baseline = await runFrontierCrossSystemBaseline({
      worlds: [world],
      tasks: [task],
      model: { providerId: "openai", modelId: "frontier-test" },
      reasoningEffort: null,
      stream: async function* () { yield { text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` }; },
    });
    let createPayload: Record<string, unknown> | null = null;
    await createFrontierBaselineChatSource({
      store,
      profileId: "default",
      model: { providerId: "openai", modelId: "frontier-test" },
      localProject: { id: "local_cross_system", name: "Cross-System Operations", workspacePath: "/tmp/cross-system-operations" },
      task,
      trajectory: baseline.trajectories[0]!,
      createSession: async (payload) => {
        createPayload = payload as Record<string, unknown>;
        return sessionFixture("frontier_chat");
      },
      appendRuntimeEvent: async () => undefined,
      addSessionSource: async () => sourceFixture("frontier_chat_source", task.worldId, "frontier_chat"),
    });
    expect(createPayload).toMatchObject({
      workspaceKind: "local_project",
      workspaceId: "local_cross_system",
      workspaceName: "Cross-System Operations",
      localProjectId: "local_cross_system",
      cwd: "/tmp/cross-system-operations",
      metadata: { crossSystemFrontierBaseline: true, localProjectId: "local_cross_system" },
    });
  }));

  test("persists per-task progress, complete results, and rebinds earlier baseline evidence", async () => withTrainingStore(async ({ store }) => {
    const project = crossSystemProject();
    const previous = await seedConversation(store, { sessionId: "unbound_frontier_chat", turnId: "unbound_frontier_turn" });
    await store.updateSession(previous.session.id, (session) => ({ ...session, metadata: { crossSystemFrontierBaseline: true }, updatedAt: FIXED_TIME }));
    await store.upsertTrainingSource(sourceFixture("unbound_frontier_source", "unbound_frontier", previous.session.id));
    const specs = worldSpecs(931);
    const expectedSequence = expectedAnswers(specs);
    let taskOrdinal = 0;
    const service = createCrossSystemFrontierBaselineService({
      store,
      findLocalProject: async (id) => id === project.id ? project : null,
      stream: async function* () {
        yield { text: `ANSWER: ${JSON.stringify(expectedSequence[taskOrdinal++])}` };
      },
      createEvidenceSource: async ({ localProject, task }) => {
        const source = { ...sourceFixture(`recorded_${task.id}`, task.worldId, `session_${task.id}`), workspaceId: localProject.id };
        return store.upsertTrainingSource(source);
      },
    });
    try {
      const started = await service.startRun({
        profileId: "default",
        localProjectId: project.id,
        worldSpecs: specs,
        model: { providerId: "openai", modelId: "frontier-test" },
        reasoningEffort: "high",
      });
      expect(started.status).toBe("queued");
      const completed = await waitForRun(store, started.id);
      expect(completed).toMatchObject({
        status: "succeeded",
        reboundSessionCount: 1,
        progress: { stage: "complete", completedTasks: 15, totalTasks: 15, outcomes: { correct: 15, infrastructureFailure: 0 } },
      });
      expect(completed.sourceIds).toHaveLength(15);
      expect(completed.result?.sources).toHaveLength(15);
      expect(completed.result?.report.exactMatchAccuracy).toBe(1);
      expect(completed.result?.sources.every((source) => source.workspaceId === project.id)).toBe(true);
      expect(await store.getSession(previous.session.id)).toMatchObject({
        workspaceKind: "local_project",
        workspaceId: project.id,
        workspaceName: project.name,
        localProjectId: project.id,
        cwd: project.workspacePath,
      });
      expect(await store.getTrainingSource("unbound_frontier_source")).toMatchObject({ workspaceId: project.id });
    } finally {
      await service.close();
    }
  }));

  test("cancels an active provider task and preserves its durable terminal state", async () => withTrainingStore(async ({ store }) => {
    const project = crossSystemProject();
    const service = createCrossSystemFrontierBaselineService({
      store,
      findLocalProject: async () => project,
      stream: async function* ({ signal }) {
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw signal.reason;
      },
      createEvidenceSource: async ({ localProject, task }) => store.upsertTrainingSource({
        ...sourceFixture(`cancelled_${task.id}`, task.worldId, `session_${task.id}`),
        workspaceId: localProject.id,
      }),
    });
    try {
      const started = await service.startRun({
        profileId: "default",
        localProjectId: project.id,
        worldSpecs: worldSpecs(941),
        model: { providerId: "openai", modelId: "frontier-test" },
        reasoningEffort: null,
      });
      await waitForRun(store, started.id, (run) => run.status === "running" && Boolean(run.progress.currentTask));
      expect(await service.cancelRun(started.id)).toMatchObject({ status: "cancelling", cancelRequested: true });
      const cancelled = await waitForRun(store, started.id);
      expect(cancelled).toMatchObject({ status: "cancelled", cancelRequested: true, error: null });
      expect(cancelled.progress.completedTasks).toBe(1);
      expect(cancelled.progress.outcomes.cancelled).toBe(1);
      expect(cancelled.sourceIds).toHaveLength(1);
    } finally {
      await service.close();
    }
  }));
});

function worldSpecs(seed: number) {
  return [
    { seed, split: "train" as const, difficulty: "easy" as const },
    { seed: seed + 1, split: "validation" as const, difficulty: "medium" as const },
    { seed: seed + 2, split: "frozen_eval" as const, difficulty: "hard" as const },
  ];
}

function expectedAnswers(specs: ReturnType<typeof worldSpecs>): Array<Record<string, unknown>> {
  return specs.flatMap((spec) => generateCrossSystemTasks(generateCrossSystemWorld(spec)))
    .filter((task) => task.phrasingVariant === 0)
    .map((task) => task.expectedAnswer);
}

function crossSystemProject() {
  return {
    id: "local_cross_system",
    name: "cross-system-operations",
    workspacePath: "/tmp/cross-system-operations",
    agentSdk: { detected: true, packageName: "openpond-agent-sdk", rootPath: "/tmp/cross-system-operations", manifestPath: "/tmp/cross-system-operations/package.json", version: "workspace", dependencyType: "dependencies" as const },
  };
}

async function waitForRun(
  store: { getCrossSystemFrontierBaselineRun(id: string): Promise<CrossSystemFrontierBaselineRun | null> },
  id: string,
  predicate: (run: CrossSystemFrontierBaselineRun) => boolean = (run) => ["succeeded", "failed", "cancelled"].includes(run.status),
): Promise<CrossSystemFrontierBaselineRun> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await store.getCrossSystemFrontierBaselineRun(id);
    if (run && predicate(run)) return run;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for frontier baseline ${id}.`);
}

function sessionFixture(id: string): Session {
  return {
    id,
    provider: "openai",
    modelRef: { providerId: "openai", modelId: "frontier-test" },
    title: "Cross-System baseline",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
