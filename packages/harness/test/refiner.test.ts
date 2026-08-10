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
  task: {
    prompt: "Update the chart labels in the attached report.",
    assistantOutput: "The report was updated after retrying with another supported method.",
    assistantOutputLinkCount: 0,
    previousAssistantOutput: null,
  },
  eventExcerpts: [],
  artifactDiagnostics: [],
  recentOutcomes: [],
  sourceFiles: [],
  sourceCatalog: [],
};

describe("public model-driven Harness Refiner", () => {
  test("treats trigger labels as evidence rather than routing authority", () => {
    const system = refinerMessages(evidence)[0]!.content;
    expect(system).toContain("Judge the evidence yourself");
    expect(system).toContain("Do not assume a supplied trigger");
    expect(system).toContain("actual user-visible answer and artifacts");
    expect(system).toContain("taskset_grade diagnostic");
    expect(system).toContain("authoritative outcome evidence");
    expect(system).toContain("bounded adaptation evaluationCriteria");
    expect(system).toContain("Do not dismiss that evidence merely as a hidden constraint");
    expect(system).toContain("missing requested citations or links");
    expect(system).toContain("assistantOutputLinkCount");
    expect(system).toContain("named sources without clickable links");
    expect(system).toContain("current web verification");
    expect(system).toContain("recurrence evidence");
    expect(system).toContain("Never force a change");
  });

  test("treats benchmark adaptation evidence as a cohort rather than one turn", () => {
    const system = refinerMessages({
      ...evidence,
      additionalEvidence: {
        reviewScope: "adaptation_cohort",
        attempts: [],
      },
    })[0]!.content;
    expect(system).toContain("review every supplied cohort attempt together");
    expect(system).toContain("primary turn is only an evidence anchor");
    expect(system).toContain("Valid passing grades do not erase avoidable tool detours");
    expect(system).toContain("high usage alone does not justify a Harness change");
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
    expect(messagesSeen[1]!.at(-1)!.content).toContain("materially different future tasks");
  });
});
