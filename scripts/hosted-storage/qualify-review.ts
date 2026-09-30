import path from "node:path";
import { localHarnessWorkspacePaths } from "../../apps/server/src/harness/local-harness-workspace-service.js";
import { rm, readFile } from "node:fs/promises";
import { createImprovementObservation, createRefinementTriggerDecision } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { type AgentHostStorageClient } from "@openpond/agent-runtime";
import { HostedHarnessReviewStorage } from "../../apps/server/src/store/hosted-harness-review-storage.js";
import { loadHostedRefinerRelease } from "../../apps/server/src/store/hosted-refiner-release.js";
import { createLocalHarnessImprovementRuntime } from "../../apps/server/src/harness/local-harness-improvement-runtime.js";
import { DEFAULT_REFINEMENT_TRIGGER_POLICY } from "../../apps/server/src/harness/improvement-trigger-detector.js";
import { createBackgroundWorkerQueue } from "../../apps/server/src/runtime/background-worker-queue.js";

/** Integration helper: the transport is a real host repository backed by disposable Postgres. */
export async function qualifyHostedReview(input: { client: AgentHostStorageClient; cacheHome: string;
  sessionId: string; turnId: string; workspaceId: string; route?: "memory" | "prompt" }) {
  let store = new HostedHarnessReviewStorage(input.client, input.cacheHome);
  const overlay = await store.getHarnessRunOverlay(input.sessionId);
  if (!overlay) throw new Error("Review probe overlay missing");
  const events = await store.runtimeEventsForTurn(input.turnId);
  const failure = events.find(event => event.name === "tool.completed" && event.status === "failed");
  if (!failure) throw new Error("Review probe recovery evidence missing");
  const workspaceBefore = await store.getHarnessWorkspace(input.workspaceId);
  if (!workspaceBefore) throw new Error("Review probe workspace missing");
  if (!(await store.getHarnessBackgroundReviewSettings(input.workspaceId)).enabled) throw new Error("Imported review intent was not preserved");
  const now = new Date().toISOString();
  const observation = createImprovementObservation({ schemaVersion: "openpond.improvementObservation.v1",
    id: `review-observation-${input.turnId}`, runRef: input.sessionId, turnId: input.turnId,
    harnessRelease: overlay.baseHarnessRelease, overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    eventRefs: [{ id: failure.id, sequence: failure.sequence ?? null, contentHash: contentHash(failure) }],
    kind: "recovery", state: "recovered", tool: { name: "exec_command", invocationKey: contentHash({ turnId: input.turnId }) },
    deterministicClass: "recovered_command_exit_nonzero", summary: "A malformed command failed and was corrected.", createdAt: now, metadata: {} });
  await store.saveHarnessImprovementArtifact(input.workspaceId, "observation", observation);
  const trigger = createRefinementTriggerDecision({ schemaVersion: "openpond.refinementTriggerDecision.v1",
    id: `review-trigger-${input.turnId}`, runRef: input.sessionId, turnId: input.turnId,
    harnessRelease: overlay.baseHarnessRelease, overlay: { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash },
    observations: [{ id: observation.id, contentHash: observation.contentHash }], decision: "queue_refiner",
    deterministicRoute: null, suggestedRoutes: ["runtime", "skill", "prompt"], reason: "Review the recovered command detour.",
    deduplicationKey: contentHash({ turnId: input.turnId, review: true }), policy: DEFAULT_REFINEMENT_TRIGGER_POLICY,
    estimatedMaxCostUsd: 0.01, pendingPlanCount: 0, boundary: { kind: "turn_completed", eventSequence: failure.sequence ?? 1, occurredAt: now },
    cooldownUntil: null, createdAt: now, metadata: {} });
  await store.saveHarnessImprovementArtifact(input.workspaceId, "trigger_decision", trigger);
  // Recreate the adapter and delete every local cache before reconciling the durable job.
  await rm(input.cacheHome, { recursive: true, force: true });
  store = new HostedHarnessReviewStorage(input.client, input.cacheHome);
  const queue = createBackgroundWorkerQueue({ queueId: "hosted-review-probe", concurrency: 1 });
  let calls = 0;
  const runtime = createLocalHarnessImprovementRuntime({ store, storeDir: input.cacheHome, queue,
    prepareReview: trigger => store.prepareReview(trigger),
    appendRuntimeEvent: event => store.appendRuntimeEvent(event),
    upsertModelUsageRecord: record => store.upsertModelUsageRecord(record),
    loadActiveRefinerRelease: () => loadHostedRefinerRelease(input.client, input.workspaceId),
    streamOpenPondHostedChatTurn: async function* () {
      calls += 1;
      const promptRoute = input.route === "prompt";
      const source = promptRoute ? await readFile(path.join(localHarnessWorkspacePaths(input.cacheHome, input.workspaceId).source,
        "instructions/system.md"), "utf8") : "";
      const anchor = source.trimEnd().split("\n").at(-1)!;
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "openpond.localHarnessRefinerDecision.v2",
        decision: "propose", route: promptRoute ? "prompt" : "memory", operation: promptRoute ? "update" : "create",
        target: promptRoute ? "instructions/system.md" : "memory/concise-replies",
        summary: "Remember the user's request for concise replies.",
        evidenceBasis: { kind: "single_deterministic", supportingEvidenceIds: [observation.id], counterevidence: [] },
        createContent: promptRoute ? null : "The user prefers concise replies.",
        find: promptRoute ? anchor : null, replace: promptRoute ? `${anchor}\nWhen a harmless command has malformed syntax, correct that command and continue from the existing checkpoint.` : null,
        expectedOutcome: "Future replies follow the explicit preference.", reason: "The user explicitly requested concise replies." }) };
    },
  });
  const recovered = await runtime.reconcilePending();
  await queue.drain();
  const failed = queue.receipts().find(receipt => receipt.status === "failed");
  if (failed) throw new Error(`Recovered review failed: ${failed.error}`);
  const outcomes = await store.listHarnessImprovementArtifacts(input.workspaceId, "refiner_outcome");
  const memory = input.route === "prompt" ? null : await store.getHarnessMemory(input.workspaceId, "concise-replies");
  const workspaceAfter = await store.getHarnessWorkspace(input.workspaceId);
  const applied = input.route === "prompt" ? workspaceAfter?.currentChannel.revision === workspaceBefore.currentChannel.revision + 1 : Boolean(memory);
  if (recovered !== 1 || calls < 1 || !applied || outcomes.length !== 1 || (await store.listPendingHarnessRefinerTriggers()).length)
    throw new Error(`Review recovery did not persist its result: ${JSON.stringify({ recovered, calls, memory, outcomes })}`);
  return { recovered, modelCalls: calls, memoryRevision: memory?.revision ?? null, channelRevision: workspaceAfter?.currentChannel.revision, outcome: outcomes[0], cacheLossRecovered: true };
}

if (process.env.OPENPOND_REVIEW_PROBE_BOOTSTRAP) {
  const { AgentHostStorageClient } = await import("@openpond/agent-runtime");
  const { createInterface } = await import("node:readline");
  const client = new AgentHostStorageClient();
  client.bind(async request => { process.stdout.write(`${JSON.stringify(request)}\n`); });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => client.accept(JSON.parse(line)));
  try {
    const input = JSON.parse(process.env.OPENPOND_REVIEW_PROBE_BOOTSTRAP);
    const result = await qualifyHostedReview({ ...input, client });
    process.stdout.write(`${JSON.stringify({ probeResult: result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    client.close();
    lines.close();
    process.stdin.destroy();
  }
}
