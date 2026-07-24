import type {
  HarnessGraderEvidence,
  LearningSignalLineage,
  ModelAction,
  ToolObservation,
} from "@openpond/contracts";
import {
  assertPortableReplay,
  contentHash,
  runPortableHarnessLocally,
  type PortableHarnessLease,
  type PortableLocalHarnessRuntime,
} from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import {
  createHarnessFixture,
  createManifestFixture,
  fixtureTimestamp,
} from "./helpers/portable-training-fixtures.js";

function hashed<T extends Record<string, unknown>>(value: T): T & {
  contentHash: string;
} {
  return { ...value, contentHash: contentHash(value) };
}

const action: ModelAction = hashed({
  id: "action-1",
  turn: 0,
  kind: "terminal",
  name: null,
  arguments: {},
  content: "42",
});

const observation: ToolObservation = hashed({
  actionId: action.id,
  turn: 0,
  terminal: true,
  output: { answer: 42 },
  artifactRefs: [],
});

const grade: HarnessGraderEvidence = hashed({
  graderId: "exact-match",
  graderVersion: "1",
  score: 1,
  passed: true,
  rewardEligible: true,
  failureClass: null,
  feedback: ["The final answer matched."],
  visibleEvidenceRefs: ["trace://visible"],
  privilegedEvidenceRefs: ["r2://private/evidence"],
});

function lineage(): LearningSignalLineage {
  const harness = createHarnessFixture().release;
  return {
    datasetRelease: {
      id: "dataset-release-1",
      contentHash: contentHash("dataset"),
    },
    harnessRelease: { id: harness.id, contentHash: harness.contentHash },
    evidenceSetRelease: null,
    profileRelease: null,
    model: {
      source: "huggingface",
      revision: "model-revision",
      artifactHash: null,
    },
    environmentHash: contentHash("environment"),
    graderHash: contentHash("grader"),
    toolContractHash: contentHash("tool"),
    verificationReceiptHash: contentHash("verification"),
  };
}

class FixtureRuntime implements PortableLocalHarnessRuntime {
  readonly calls: string[] = [];

  constructor(private readonly failStep = false) {}

  async create(): Promise<PortableHarnessLease> {
    this.calls.push("create");
    return { id: "lease-1", metadata: {} };
  }

  async reset(): Promise<void> {
    this.calls.push("reset");
  }

  async step(): Promise<ToolObservation> {
    this.calls.push("step");
    if (this.failStep) throw new Error("injected transport failure");
    return observation;
  }

  async grade(): Promise<HarnessGraderEvidence[]> {
    this.calls.push("grade");
    return [grade];
  }

  async collect() {
    this.calls.push("collect");
    return { artifactRefs: ["r2://runs/trace.json"], metadata: {} };
  }

  async destroy(): Promise<void> {
    this.calls.push("destroy");
  }
}

describe("portable local harness runtime", () => {
  it("executes the complete lifecycle and produces reward-bearing evidence", async () => {
    const runtime = new FixtureRuntime();
    const result = await runPortableHarnessLocally({
      manifest: createManifestFixture(),
      task: { id: "task-1", input: { question: "six times seven" } },
      seed: "17",
      actions: [action],
      runtime,
      lineage: lineage(),
      now: () => fixtureTimestamp,
    });
    expect(runtime.calls).toEqual([
      "create",
      "reset",
      "step",
      "grade",
      "collect",
      "destroy",
    ]);
    expect(result.trace.events.map((event) => event.type)).toEqual([
      "created",
      "reset",
      "action",
      "observation",
      "terminal",
      "graded",
      "feedback",
      "collected",
      "destroyed",
    ]);
    expect(result.trace.learningSignals.map((signal) => signal.kind)).toEqual([
      "trajectory",
      "reward",
      "grader_evidence",
      "targeted_feedback",
    ]);
    assertPortableReplay(result.trace, result.trace);
  });

  it("classifies runtime failures outside reward-bearing learning and still cleans up", async () => {
    const runtime = new FixtureRuntime(true);
    const result = await runPortableHarnessLocally({
      manifest: createManifestFixture(),
      task: { id: "task-1", input: {} },
      seed: "17",
      actions: [action],
      runtime,
      lineage: lineage(),
      now: () => fixtureTimestamp,
    });
    expect(runtime.calls).toEqual(["create", "reset", "step", "collect", "destroy"]);
    expect(result.trace.failureClass).toBe("infrastructure_failure");
    expect(result.trace.learningSignals).toHaveLength(1);
    expect(result.trace.learningSignals[0]).toMatchObject({
      kind: "infrastructure_failure",
      approved: false,
      payload: { rewardEligible: false },
    });
  });
});
