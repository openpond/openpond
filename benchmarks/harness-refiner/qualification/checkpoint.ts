import { promises as fs } from "node:fs";
import path from "node:path";

import { contentHash } from "@openpond/harness";

import type { SqliteStore } from
  "../../../apps/server/src/store/store.js";
import { runLocalHarnessRefinerWorker } from
  "../../../apps/server/src/harness/local-harness-refiner-worker.js";
import { event } from "../../../apps/server/src/utils.js";
import type { QualificationModelMeter, QualificationUsage } from "./model-meter.js";
import { HARNESS_REFINER_QUALIFICATION_LIMITS } from "./protocol.js";

type Invocation = {
  schemaVersion: "openpond.harnessRefinerQualificationInvocation.v1";
  id: string;
  scenarioId: string;
  invocationOrdinal: number;
  trigger: { id: string; contentHash: string };
  status: "completed" | "failed";
  outcome: { id: string; contentHash: string; decision: string } | null;
  inputHarness: { id: string; contentHash: string };
  outputHarness: { id: string; contentHash: string };
  usage: QualificationUsage;
  failure: { kind: string; message: string; retryable: boolean } | null;
  startedAt: string;
  completedAt: string;
  contentHash: string;
};

export async function runQualificationRefiner(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
  scenarioId: string;
  sessionId: string;
  turnId: string;
  trigger: Parameters<typeof runLocalHarnessRefinerWorker>[0]["trigger"];
  meter: QualificationModelMeter;
  additionalEvidence?: unknown;
  reviewScope?: "completed_turn" | "cross_run_candidate";
  now?: () => string;
}) {
  for (
    let ordinal = 0;
    ordinal < HARNESS_REFINER_QUALIFICATION_LIMITS.maxRefinerInvocationsPerScenario;
    ordinal += 1
  ) {
    const workspace = await input.store.getHarnessWorkspace(input.workspaceId);
    const inputHarness = workspace?.currentChannel.release;
    if (!workspace || !inputHarness) {
      throw new Error("Qualification Refiner workspace has no current Harness release.");
    }
    const usageBefore = input.meter.snapshot();
    const startedAt = new Date().toISOString();
    try {
      const worker = await runLocalHarnessRefinerWorker({
        store: input.store,
        storeDir: input.storeDir,
        trigger: input.trigger,
        additionalEvidence: input.additionalEvidence,
        reviewScope: input.reviewScope,
        stream: input.meter.refinerStream,
        signal: new AbortController().signal,
        now: input.now,
      });
      const outputHarness = worker.workspace.currentChannel.release;
      if (!outputHarness) throw new Error("Qualification Refiner removed the current release.");
      await appendInvocation(input.storeDir, invocation({
        scenarioId: input.scenarioId,
        invocationOrdinal: ordinal,
        trigger: ref(input.trigger),
        status: "completed",
        outcome: {
          ...ref(worker.outcome),
          decision: worker.outcome.decision,
        },
        inputHarness: ref(inputHarness),
        outputHarness: ref(outputHarness),
        usage: usageDelta(usageBefore, input.meter.snapshot()),
        failure: null,
        startedAt,
        completedAt: new Date().toISOString(),
      }));
      return worker;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const kind = /timed out|timeout/i.test(message)
        ? "timeout"
        : /invalid structured output|JSON|response limit/i.test(message)
          ? "invalid_output"
          : "provider_or_worker_failure";
      const retryable = ordinal + 1
        < HARNESS_REFINER_QUALIFICATION_LIMITS.maxRefinerInvocationsPerScenario;
      await appendInvocation(input.storeDir, invocation({
        scenarioId: input.scenarioId,
        invocationOrdinal: ordinal,
        trigger: ref(input.trigger),
        status: "failed",
        outcome: null,
        inputHarness: ref(inputHarness),
        outputHarness: ref(inputHarness),
        usage: usageDelta(usageBefore, input.meter.snapshot()),
        failure: { kind, message: message.slice(0, 2_000), retryable },
        startedAt,
        completedAt,
      }));
      await input.store.appendRuntimeEvent(event({
        sessionId: input.sessionId,
        turnId: input.turnId,
        name: "harness.refiner.failed",
        source: "server",
        status: "failed",
        output: message,
        data: {
          qualification: true,
          scenarioId: input.scenarioId,
          trigger: ref(input.trigger),
          invocationOrdinal: ordinal,
          failureKind: kind,
          retryable,
        },
      })).catch(() => undefined);
      if (!retryable) throw error;
    }
  }
  throw new Error("Qualification Refiner exhausted its bounded retry policy.");
}

function invocation(input: Omit<Invocation, "schemaVersion" | "id" | "contentHash">): Invocation {
  const core = {
    schemaVersion: "openpond.harnessRefinerQualificationInvocation.v1" as const,
    id: `qualification-invocation-${contentHash({
      scenarioId: input.scenarioId,
      invocationOrdinal: input.invocationOrdinal,
      trigger: input.trigger,
    }).slice(0, 24)}`,
    ...input,
  };
  return { ...core, contentHash: contentHash(core) };
}

async function appendInvocation(storeDir: string, next: Invocation): Promise<void> {
  const directory = path.join(storeDir, "training", "harness-refiner-qualification");
  const file = path.join(directory, "invocations.json");
  await fs.mkdir(directory, { recursive: true });
  let current: Invocation[] = [];
  try {
    current = JSON.parse(await fs.readFile(file, "utf8")) as Invocation[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = [
    ...current.filter((item) => item.id !== next.id),
    next,
  ];
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function usageDelta(before: QualificationUsage, after: QualificationUsage): QualificationUsage {
  return {
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    totalTokens: after.totalTokens - before.totalTokens,
    estimatedCostUsd: after.estimatedCostUsd - before.estimatedCostUsd,
    requestCount: after.requestCount - before.requestCount,
  };
}

function ref(value: { id: string; contentHash: string }) {
  return { id: value.id, contentHash: value.contentHash };
}
