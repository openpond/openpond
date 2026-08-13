import { describe, expect, test } from "vitest";

import {
  authorLocalHarnessRefinementWithModel,
  refinerMessages,
  type HarnessRefinerMessage,
  type LocalHarnessRefinerEvidence,
} from "../src/index.js";

const evidence: LocalHarnessRefinerEvidence = {
  trigger: { decision: "queue_refiner", suggestedRoutes: ["runtime"] },
  observations: [{ kind: "recovery", rawError: "PDF edit failed", recovered: true }],
  reviewPacket: {
    currentTurn: {
      id: "turn-1",
      status: "completed",
      error: null,
      prompt: "Update the chart labels in the attached report.",
      assistantOutput: "The report was updated after retrying with another supported method.",
      assistantOutputLinkCount: 0,
    },
    priorConversation: [],
    timeline: [],
    artifacts: [],
    artifactDiagnostics: [],
    executionProfile: {
      modelRequestCount: 2,
      failedModelRequestCount: 0,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      toolFailureCount: 0,
      retryCount: 0,
      recoveryCount: 0,
    },
    priorIncidents: [],
    truncation: {
      timelineEventCount: 0,
      includedTimelineEventCount: 0,
      timelineTruncated: false,
    },
  },
  sourceFiles: [],
  sourceCatalog: [],
};

describe("public model-driven Harness Refiner", () => {
  test("treats trigger labels as evidence rather than routing authority", () => {
    const system = refinerMessages(evidence)[0]!.content;
    expect(system).toContain("Judge the evidence yourself");
    expect(system).toContain("chronological incident record");
    expect(system).toContain("visible answer and artifact inventory");
    expect(system).toContain("taskset_grade diagnostic");
    expect(system).toContain("authoritative evaluation evidence");
    expect(system).toContain("one high-confidence deterministic failure");
    expect(system).toContain("Recurrence strengthens confidence");
    expect(system).toContain("Routing records ownership");
    expect(system).toContain("does not blame the agent");
    expect(system).toContain("does not require recurrence");
    expect(system).toContain("good fallback");
    expect(system).toContain("Never force a change");
    expect(system).toContain("Optimize future work");
  });

  test("treats benchmark adaptation evidence as a cohort rather than one turn", () => {
    const system = refinerMessages({
      ...evidence,
      additionalEvidence: {
        reviewScope: "adaptation_cohort",
        attempts: [],
      },
    })[0]!.content;
    expect(system).toContain("Review every supplied attempt");
    expect(system).toContain("primary turn is only a transport anchor");
    expect(system).toContain("behaviorFamilies");
    expect(system).toContain("crossTaskToolFailureGroups");
    expect(system).toContain("materially different tasks");
    expect(system).toContain("Foreground-token efficiency is the cohort objective");
    expect(system).toContain("Quality grades are a separate safety gate");
    expect(system).toContain("Prefer subtractive changes");
    expect(system).toContain("Reject a broad quality guardrail");
  });

  test("authors and repairs validated public decisions", async () => {
    let calls = 0;
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      stream: async function* () {
        calls += 1;
        if (calls === 1) {
          yield { text: "not json" };
          return;
        }
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v1",
          decision: "no_action",
          reason: "The single recovered turn does not yet justify durable Harness content.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    expect(decision.decision).toBe("no_action");
  });

  test("requires a model critique before returning a proposal", async () => {
    const messagesSeen: HarnessRefinerMessage[][] = [];
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      stream: async function* ({ messages }) {
        messagesSeen.push(messages);
        if (messagesSeen.length === 1) {
          yield { text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v1",
            decision: "propose",
            route: "skill",
            operation: "create",
            target: "skills/chart-label-fix/SKILL.md",
            summary: "Encode the exact chart-label task.",
            createContent: "---\nname: chart-label-fix\n---\nRepeat this task.",
            find: null,
            replace: null,
            expectedOutcome: "Repeat this specific workflow.",
            reason: "One turn showed a recoverable issue.",
          }) };
          return;
        }
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v1",
          decision: "no_action",
          reason: "The draft encodes one task rather than a reusable root behavior.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(decision.decision).toBe("no_action");
    expect(messagesSeen).toHaveLength(2);
    expect(messagesSeen[1]!.at(-1)!.content).toContain("mandatory independent critique");
    expect(messagesSeen[1]!.at(-1)!.content).toContain("failure mechanism");
    expect(messagesSeen[1]!.at(-1)!.content).toContain(
      "Do not reject a concise correction merely because",
    );
  });
});
