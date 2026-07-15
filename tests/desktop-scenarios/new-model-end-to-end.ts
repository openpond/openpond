import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  TasksetSchema,
  type LocalProject,
  type Session,
  type TaskCreationSnapshot,
  type TaskMinerRun,
  type TrainingApproval,
  type TrainingBundleManifest,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import { inspectTaskset } from "../../packages/taskset-sdk/src";
import { desktopScenario } from "../../scripts/desktop-harness/scenario";
import type { DesktopHarness } from "../../scripts/desktop-harness/types";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  type CrossSystemBaselineReport,
  type CrossSystemWorldSpec,
} from "../../apps/server/src/training/cross-system-operations";
import {
  reloadRenderer,
  waitForAssistantOutput,
  waitForCompletedTurn,
  waitForRendererCondition,
} from "./helpers";
import {
  addTrainingSource,
  createTrainingChat,
  fixtureSftRecipe,
  initializeTrainingProfile,
  registerTrainingModel,
  trainingState,
} from "./training-helpers";

const WORLD_SPECS: CrossSystemWorldSpec[] = [
  { seed: 301, split: "train", difficulty: "easy" },
  { seed: 302, split: "validation", difficulty: "medium" },
  { seed: 303, split: "frozen_eval", difficulty: "hard" },
];

export default desktopScenario({
  name: "new-model-end-to-end",
  mode: "isolated",
  timeoutMs: 300_000,
  async run(harness) {
    const baselineModel = await registerTrainingModel(harness, "cross-system-baseline");
    await initializeTrainingProfile(harness);

    const projectImport = await harness.api.fetchJson<{ project: LocalProject }>("/v1/projects", {
      method: "POST",
      body: { path: path.join(harness.repoRoot, "packages", "agent-sdk", "examples", "cross-system-operations") },
    });
    const project = projectImport.project;
    assert(project.agentSdk?.detected === true, "Cross-System Operations did not import as a normal Agent SDK project.");

    const worlds = WORLD_SPECS.map(generateCrossSystemWorld);
    const baselineTasks = worlds.flatMap(generateCrossSystemTasks).filter((task) => task.phrasingVariant === 0);
    const sessions: Session[] = [];
    for (const [index, task] of baselineTasks.entries()) {
      sessions.push(await createTrainingChat(
        harness,
        baselineModel,
        `Cross-System Operations ${task.family} ${index + 1}`,
        task.prompt,
        project,
      ));
    }
    const sources = await Promise.all(sessions.map((session) => addTrainingSource(harness, session.id)));
    const fixtureBaseline = await harness.api.fetchJson<{
      report: CrossSystemBaselineReport;
      trajectories: Array<{ id: string; taskId: string; worldId: string }>;
      results: Array<{ trajectoryId: string; outcome: string; reward: number | null }>;
      bootstrap: Array<{ trajectoryId: string; messages: Array<{ role: string; tool_calls?: unknown[] }> }>;
    }>("/v1/training/cross-system-operations/fixture-baseline", {
      method: "POST",
      body: {
        profileId: "default",
        sourceIds: sources.map((source) => source.id),
        worldSpecs: WORLD_SPECS,
        model: baselineModel,
        approvedBy: "desktop_harness_user",
      },
    });
    assert(fixtureBaseline.report.reward.variance > 0, "Fixture baseline did not produce reward variance.");
    assert(fixtureBaseline.bootstrap.length > 0, "Fixture baseline produced no approved structured trajectories.");
    assert(fixtureBaseline.bootstrap.every((record) => record.messages.some((message) => message.role === "tool") && record.messages.some((message) => message.tool_calls?.length)), "Bootstrap messages lost typed tool calls or results.");

    const miner = await harness.api.fetchJson<TaskMinerRun>("/v1/training/miner/run", {
      method: "POST",
      body: { profileId: "default", sourceIds: sources.map((source) => source.id) },
    });
    const completedMiner = await waitForMiner(harness, miner.id);
    assert(completedMiner.status === "succeeded" && completedMiner.candidateIds.length === 1, `Task Miner ended as ${completedMiner.status} with ${completedMiner.candidateIds.length} candidates.`);
    let state = await trainingState(harness);
    const candidate = state.candidates.find((item) => item.id === completedMiner.candidateIds[0]);
    assert(candidate, "Cross-System Operations candidate was not persisted.");
    assert(candidate.recommendation.tactic === "grpo_rft", "Task Miner did not recommend GRPO/RFT.");
    assert(candidate.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH, "Candidate lost the shared tool-contract hash.");

    const disclosed = await harness.api.fetchJson<TaskCreationSnapshot>(`/v1/training/candidates/${candidate.id}/create`, {
      method: "POST",
      body: { mode: "defaults", analysisModel: null },
    });
    const proposed = disclosed;
    assert(proposed.state === "awaiting_materialization_approval" && proposed.proposal, `Task Creator did not produce a materializable proposal: ${proposed.state}: ${proposed.blockedReason ?? "no blocked reason"}.`);
    assert(proposed.proposal.proposedMethod === "grpo", "Task Creator silently changed the primary method.");
    assert(proposed.proposal.trainingPath?.primaryMethod === "grpo" && proposed.proposal.trainingPath.bootstrap?.purpose === "trajectory_bootstrap", "Task Creator did not preserve the separate SFT precursor.");
    assert(proposed.proposal.proposedExamples.length === fixtureBaseline.bootstrap.length, "Task Creator included unsuccessful or unapproved trajectories.");

    const materialized = await harness.api.fetchJson<TaskCreationSnapshot>(`/v1/training/task-creations/${proposed.id}/materialize`, {
      method: "POST",
      body: { approved: true },
    });
    assert(materialized.materializedTasksetId, `Taskset materialization failed: ${materialized.blockedReason ?? materialized.state}.`);
    const tasksetRoot = path.join(harness.artifactsDir, "profile-repo", "profiles", "default", "tasksets", materialized.materializedTasksetId);
    const tasksetPath = path.join(tasksetRoot, "taskset.json");
    const taskset = TasksetSchema.parse(JSON.parse(await readFile(tasksetPath, "utf8")));
    const inspection = await inspectTaskset(tasksetPath);
    assert(inspection.report.valid, `Generated Taskset is invalid: ${inspection.report.issues.map((issue) => issue.message).join("; ")}`);
    assert(taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH && taskset.environment.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH, "Taskset environment contract drifted from the Agent SDK project.");
    assert(taskset.tasks.every((task) => task.tags.includes("structured-tool-trajectory") && Array.isArray(task.input.messages) && Array.isArray(task.expectedOutput?.messages)), "Taskset flattened structured bootstrap messages.");
    assert(new Set(taskset.tasks.filter((task) => task.split === "train").map((task) => task.clusterKey)).intersection(new Set(taskset.tasks.filter((task) => task.split === "frozen_eval").map((task) => task.clusterKey))).size === 0, "Train and frozen-evaluation world clusters overlap.");

    const audit = await harness.api.fetchJson<{ report: { id: string; passed: boolean; hackingChecksPassed: boolean; leakageChecksPassed: boolean; infrastructureSafetyPassed: boolean } }>("/v1/training/audit-graders", {
      method: "POST",
      body: { tasksetId: taskset.id },
    });
    assert(audit.report.passed && audit.report.hackingChecksPassed && audit.report.leakageChecksPassed && audit.report.infrastructureSafetyPassed, "Generated verifier audit failed.");
    const evaluationBaseline = await harness.api.fetchJson<{ report: { id: string; tasksetHash: string } }>("/v1/training/baseline", {
      method: "POST",
      body: { tasksetId: taskset.id, models: [baselineModel], seeds: [17], attemptsPerTask: 1 },
    });
    assert(evaluationBaseline.report.tasksetHash === taskset.contentHash, "Persisted baseline used a stale Taskset hash.");
    const readiness = await harness.api.fetchJson<{ ready: boolean; recommendedMethod: string; trainingPath: { primaryMethod: string; bootstrap: { method: string } | null } | null }>("/v1/training/readiness", {
      method: "POST",
      body: { tasksetId: taskset.id },
    });
    assert(readiness.ready && readiness.recommendedMethod === "grpo" && readiness.trainingPath?.bootstrap?.method === "sft", "Readiness did not preserve the staged GRPO/SFT path.");

    const plan = await harness.api.fetchJson<TrainingPlan>("/v1/training/plans", {
      method: "POST",
      body: { tasksetId: taskset.id, destinationId: "local_cpu_fixture", recipe: fixtureSftRecipe(), exportApproved: true },
    });
    assert(plan.compatibility.compatible, "The explicit SFT bootstrap plan is not compatible with the fixture destination.");
    const built = await harness.api.fetchJson<{ manifest: TrainingBundleManifest }>("/v1/training/bundles", {
      method: "POST",
      body: { planId: plan.id },
    });
    const approval = await harness.api.fetchJson<TrainingApproval>("/v1/training/approvals", {
      method: "POST",
      body: { planId: plan.id, bundleId: built.manifest.id, approvedBy: "desktop_harness_user" },
    });
    const launched = await harness.api.fetchJson<TrainingJob>("/v1/training/launch", {
      method: "POST",
      body: { planId: plan.id, approvalId: approval.id },
    });
    state = await waitForTrainingJob(harness, launched.id);
    const completedJob = state.jobs.find((job) => job.id === launched.id);
    assert(completedJob?.status === "succeeded", `SFT bootstrap failed: ${completedJob?.status} ${completedJob?.error ?? ""}`);
    const jobEvents = await harness.api.fetchJson<Array<{ type: string; payload: Record<string, unknown> }>>(`/v1/training/jobs/${launched.id}/events`);
    assert(jobEvents.some((event) => event.type === "metric" && event.payload.metricKind === "sft_step"), "SFT bootstrap did not persist optimizer-step telemetry.");
    const adapter = state.artifacts.find((artifact) => artifact.jobId === launched.id && artifact.kind === "adapter");
    const evaluation = state.artifacts.find((artifact) => artifact.jobId === launched.id && artifact.kind === "evaluation");
    const model = state.models.find((item) => item.jobId === launched.id);
    assert(adapter && evaluation && model, "Adapter, evaluation receipt, or registered model lineage is missing.");
    assert(model.tasksetHash === taskset.contentHash && model.planHash === plan.contentHash && model.bundleHash === built.manifest.contentHash, "Registered model lineage does not match Taskset/plan/bundle hashes.");
    assert(model.frozenEvaluationArtifactId === evaluation.id, "Registered model did not retain the frozen-evaluation receipt.");

    const chatTask = taskset.tasks[0]!;
    const secondChatTask = taskset.tasks[1]!;
    const firstChat = await runConstrainedModelChatThroughUi(harness, {
      project,
      modelId: model.id,
      prompt: String(chatTask.input.prompt),
      secondPrompt: String(secondChatTask.input.prompt),
      tasksetName: taskset.name,
      title: "Cross-System trained model chat",
    });
    harness.recordAssertion("constrainedToolCallBeforeRestart", firstChat.toolEvent.action === "search_crm");
    harness.recordAssertion("normalChatFinalBeforeRestart", firstChat.output.includes("ANSWER: {}"));
    harness.recordAssertion("secondGeneratedToolCallBeforeRestart", firstChat.secondToolEvent?.action === "search_crm");
    harness.recordAssertion("secondGeneratedFinalBeforeRestart", firstChat.secondOutput.includes("ANSWER: {}"));
    harness.recordAssertion("normalComposerHandoffVisible", firstChat.handoffVisible);
    harness.recordAssertion("normalComposerSourceProjectBound", firstChat.localProjectId === project.id);

    await harness.screenshot("new-model-end-to-end-before-restart");

    assert(harness.restart, "This scenario requires isolated desktop restart support.");
    await harness.restart();
    await harness.api.health();
    state = await trainingState(harness);
    const reloadedModel = state.models.find((item) => item.id === model.id);
    const bootstrap = await harness.api.bootstrap<{ localProjects?: LocalProject[] }>();
    assert(reloadedModel?.jobId === launched.id, "Registered model did not reconcile after restart.");
    assert(bootstrap.localProjects?.some((item) => item.id === project.id && item.agentSdk?.detected), "Synthetic Agent SDK project did not reconcile after restart.");
    const secondChat = await runConstrainedModelChatThroughUi(harness, {
      project,
      modelId: model.id,
      prompt: String(chatTask.input.prompt),
      tasksetName: taskset.name,
      title: "Cross-System trained model chat after restart",
    });
    harness.recordAssertion("constrainedToolCallAfterRestart", secondChat.toolEvent.action === "search_crm");
    harness.recordAssertion("normalChatFinalAfterRestart", secondChat.output.includes("ANSWER: {}"));
    harness.recordAssertion("noActiveTrainingWorker", state.jobs.every((job) => !["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status)));

    await harness.screenshot("new-model-end-to-end-after-restart");
    harness.recordMetadata({
      projectId: project.id,
      projectPath: project.path,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      worldIds: worlds.map((world) => world.id),
      sourceIds: sources.map((source) => source.id),
      trajectoryIds: fixtureBaseline.trajectories.map((trajectory) => trajectory.id),
      baselineId: fixtureBaseline.report.id,
      candidateId: candidate.id,
      taskCreationId: proposed.id,
      baselineModel,
      authoringConfiguration: { mode: "local_heuristic", analysisModel: null },
      tasksetId: taskset.id,
      tasksetHash: taskset.contentHash,
      graderId: taskset.graders[0]?.id ?? null,
      graderVersion: taskset.graders[0]?.version ?? null,
      graderAuditId: audit.report.id,
      evaluationBaselineId: evaluationBaseline.report.id,
      planId: plan.id,
      planHash: plan.contentHash,
      bundleId: built.manifest.id,
      bundleHash: built.manifest.contentHash,
      jobId: launched.id,
      adapterArtifactId: adapter.id,
      evaluationArtifactId: evaluation.id,
      modelId: model.id,
      chatSessionIds: [firstChat.sessionId, secondChat.sessionId],
      chatTaskIds: [chatTask.metadata.taskId, secondChatTask.metadata.taskId],
    });
  },
});

async function waitForMiner(harness: DesktopHarness, runId: string): Promise<TaskMinerRun> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await trainingState(harness);
    const run = state.minerRuns.find((item) => item.id === runId);
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await delay(100);
  }
  throw new Error("Timed out waiting for the Cross-System Task Miner run.");
}

async function waitForTrainingJob(harness: DesktopHarness, jobId: string) {
  const deadline = Date.now() + 150_000;
  let state = await trainingState(harness);
  while (Date.now() < deadline) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return state;
    await delay(250);
    state = await trainingState(harness);
  }
  throw new Error("Timed out waiting for the local SFT bootstrap.");
}

async function runConstrainedModelChatThroughUi(harness: DesktopHarness, input: {
  project: LocalProject;
  modelId: string;
  prompt: string;
  secondPrompt?: string;
  tasksetName: string;
  title: string;
}) {
  const before = await harness.api.bootstrap<{ sessions?: Session[] }>();
  const previousSessionIds = new Set((before.sessions ?? []).map((session) => session.id));
  await reloadRenderer(harness);
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Training');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
    "Training navigation",
  );
  await waitForRendererCondition(
    harness,
    `(() => {
      const button = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent?.trim().startsWith('Models'));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
    "Models tab",
  );
  await waitForRendererCondition(
    harness,
    `(() => {
      const row = [...document.querySelectorAll('.training-models-table tbody tr')]
        .find((item) => item.textContent?.includes(${JSON.stringify(input.tasksetName)}));
      const button = row?.querySelector('.training-table-chat');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
    `Chat handoff for ${input.tasksetName}`,
  );
  await harness.renderer.assertText("Generated Taskset question", { label: "generated Taskset chat handoff" });
  await harness.renderer.assertText(input.tasksetName, { label: "generated Taskset name in chat handoff" });
  await harness.renderer.submitComposer(input.prompt);

  const session = await waitForNewModelChatSession(harness, {
    previousSessionIds,
    modelId: input.modelId,
    projectId: input.project.id,
  });
  let toolEvent;
  try {
    toolEvent = await harness.events.waitForToolCompleted(session.id, "search_crm", { timeoutMs: 45_000 });
  } catch (error) {
    const bootstrap = await harness.api.bootstrap<{ events?: Array<Record<string, unknown>> }>();
    const events = (bootstrap.events ?? []).filter((event) => event.sessionId === session.id);
    throw new Error(`${error instanceof Error ? error.message : String(error)} Session events: ${JSON.stringify(events.slice(-20))}`);
  }
  const delta = await waitForAssistantOutput(harness, session.id, "ANSWER: {}", `${input.title} final answer`);
  await waitForCompletedTurn(harness, session.id, delta, `${input.title} completion`);
  let secondToolEvent = null;
  let secondOutput = "";
  if (input.secondPrompt) {
    await waitForRendererCondition(
      harness,
      `document.querySelector('.training-chat-handoff small')?.textContent?.includes('2 of') === true`,
      "second generated Taskset question",
    );
    await harness.renderer.submitComposer(input.secondPrompt);
    secondToolEvent = await harness.events.waitFor(
      (event) =>
        event.sessionId === session.id &&
        event.turnId !== delta.turnId &&
        event.name === "tool.completed" &&
        event.action === "search_crm" &&
        (event.status === undefined || event.status === "completed"),
      `second generated search_crm completion in ${session.id}`,
      { timeoutMs: 45_000, sessionId: session.id },
    );
    const secondDelta = await harness.events.waitFor(
      (event) =>
        event.sessionId === session.id &&
        event.turnId === secondToolEvent?.turnId &&
        event.name === "assistant.delta" &&
        typeof event.output === "string" &&
        event.output.includes("ANSWER: {}"),
      `${input.title} second generated final answer`,
      { sessionId: session.id },
    );
    await harness.events.waitFor(
      (event) =>
        event.sessionId === session.id &&
        event.turnId === secondToolEvent?.turnId &&
        event.name === "turn.completed" &&
        event.status === "completed",
      `${input.title} second generated completion`,
      { sessionId: session.id },
    );
    secondOutput = secondDelta.output ?? "";
  }
  return {
    sessionId: session.id,
    toolEvent,
    output: delta.output ?? "",
    secondToolEvent,
    secondOutput,
    handoffVisible: true,
    localProjectId: session.localProjectId ?? session.workspaceId ?? null,
  };
}

async function waitForNewModelChatSession(harness: DesktopHarness, input: {
  previousSessionIds: ReadonlySet<string>;
  modelId: string;
  projectId: string;
}): Promise<Session> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const bootstrap = await harness.api.bootstrap<{ sessions?: Session[] }>();
    const session = (bootstrap.sessions ?? []).find((candidate) =>
      !input.previousSessionIds.has(candidate.id) &&
      candidate.modelRef?.providerId === "local-adapter" &&
      candidate.modelRef.modelId === input.modelId &&
      (candidate.localProjectId === input.projectId || candidate.workspaceId === input.projectId));
    if (session) return session;
    await delay(100);
  }
  throw new Error(`Timed out waiting for the normal composer to create a ${input.modelId} chat in project ${input.projectId}.`);
}

function assert<T>(value: T, message: string): asserts value is NonNullable<T> {
  if (!value) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
