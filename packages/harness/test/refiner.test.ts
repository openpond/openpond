import { describe, expect, test } from "vitest";

import {
  admitLocalHarnessRefinerDecision,
  admitRefinerProfileDecision,
  DEFAULT_REFINER_REVIEW_PROFILE,
  authorLocalHarnessRefinementWithModel,
  refinerMessages,
  type HarnessRefinerMessage,
  type LocalHarnessRefinerEvidence,
} from "../src/index.js";

const evidence: LocalHarnessRefinerEvidence = {
  capabilities: { memory: true, prompt: true, skill: true, agent: false },
  trigger: { decision: "queue_refiner", suggestedRoutes: ["runtime"] },
  observations: [{ id: "observation-1", kind: "recovery", rawError: "PDF edit failed", recovered: true }],
  admissibleEvidenceIds: ["observation-1"],
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
  runtimeActivation: {
    admittedRelease: { id: "harness-admitted", contentHash: "a".repeat(64) },
    currentRelease: { id: "harness-admitted", contentHash: "a".repeat(64) },
    rebasedOntoCurrent: false,
    admittedSourceFiles: [],
    admittedSourceCatalog: [],
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
    expect(system).toContain("proves only the measured outcome");
    expect(system).toContain("one high-confidence deterministic failure");
    expect(system).toContain("Recurrence strengthens confidence");
    expect(system).toContain("Routing records ownership");
    expect(system).toContain("does not blame the agent");
    expect(system).toContain("does not require recurrence");
    expect(system).toContain("good fallback");
    expect(system).toContain("Never force a change");
    expect(system).toContain("Optimize future work");
    expect(system).toContain("runtimeActivation is authoritative");
    expect(system).toContain("violated an already-loaded Harness instruction");
    expect(system).toContain("observable invariant");
    expect(system).toContain("immediate completed-turn review");
    expect(system).toContain("supportingEvidenceIds");
    expect(system).toContain("admissibleEvidenceIds");
    expect(system).toContain("explicitly stated durable user preference");
    expect(system).toContain("capabilities is authoritative");
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

  test("composes Review Profile instructions and deterministically narrows routes", () => {
    const profile = {
      ...DEFAULT_REFINER_REVIEW_PROFILE,
      id: "customer.review",
      version: "2",
      instructions: [{ id: "pdf-completion", text: "Treat unreadable requested PDFs as material evidence." }],
      allowedProposalRoutes: ["prompt"] as Array<"memory" | "prompt" | "skill" | "agent">,
    };
    expect(refinerMessages(evidence, profile)[0]?.content).toContain(
      "[pdf-completion] Treat unreadable requested PDFs as material evidence.",
    );
    expect(admitRefinerProfileDecision({
      schemaVersion: "openpond.localHarnessRefinerDecision.v2",
      decision: "propose",
      route: "skill",
      operation: "create",
      target: "skills/pdf/SKILL.md",
      summary: "Add PDF guidance.",
      evidenceBasis: { kind: "single_deterministic", supportingEvidenceIds: ["observation-1"], counterevidence: [] },
      createContent: "PDF guidance",
      find: null,
      replace: null,
      expectedOutcome: "Fewer PDF failures.",
      reason: "The profile excludes Skill proposals.",
    }, profile)).toMatchObject({ decision: "no_action" });
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
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "no_action",
          reason: "The single recovered turn does not yet justify durable Harness content.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(3);
    expect(decision.decision).toBe("no_action");
  });

  test("challenges a no-action decision when recovered tool failures expose a prevention rule", async () => {
    let calls = 0;
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      stream: async function* () {
        calls += 1;
        if (calls === 1) {
          yield { text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "no_action",
            reason: "The user-facing artifact succeeded after recovery.",
          }) };
          return;
        }
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "propose",
          route: "skill",
          operation: "create",
          target: "skills/pdf-tool-preflight/SKILL.md",
          summary: "Prevent known PDF tool incompatibilities before generation.",
          evidenceBasis: {
            kind: "single_deterministic",
            supportingEvidenceIds: ["observation-1"],
            counterevidence: [],
          },
          createContent: "---\nname: pdf-tool-preflight\n---\nVerify compatible PDF APIs and fonts before generating a document.",
          find: null,
          replace: null,
          expectedOutcome: "Future PDF work avoids the observed incompatible tool path.",
          reason: "The recovered failure exposes a reusable prevention rule.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    expect(decision).toMatchObject({
      decision: "propose",
      target: "skills/pdf-tool-preflight/SKILL.md",
    });
  });

  test("does not treat an ignored loaded instruction as evidence for no action", async () => {
    const loadedInstruction = {
      path: "instructions/system.md",
      kind: "instruction" as const,
      loaded: true,
      content: "Avoid piping large font listings through head; constrain the query at the source.",
    };
    const ignoredInstructionEvidence: LocalHarnessRefinerEvidence = {
      ...evidence,
      observations: [{
        id: "observation-sigpipe",
        kind: "tool_failure",
        rawError: "fc-list | head exited with SIGPIPE (exit 141)",
        recovered: true,
      }],
      runtimeActivation: {
        ...evidence.runtimeActivation,
        admittedSourceFiles: [loadedInstruction],
        admittedSourceCatalog: [{ path: loadedInstruction.path, kind: loadedInstruction.kind, loaded: true }],
      },
      sourceFiles: [loadedInstruction],
      sourceCatalog: [{ path: "instructions/system.md", kind: "instruction", loaded: true }],
    };
    const messagesSeen: HarnessRefinerMessage[][] = [];
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence: ignoredInstructionEvidence,
      stream: async function* ({ messages }) {
        messagesSeen.push(messages);
        if (messagesSeen.length === 1) {
          yield { text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "no_action",
            reason: "The existing instruction already covers this failure.",
          }) };
          return;
        }
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "propose",
          route: "prompt",
          operation: "update",
          target: "instructions/system.md",
          summary: "Make font discovery guidance an explicit preflight.",
          evidenceBasis: {
            kind: "single_deterministic",
            supportingEvidenceIds: ["observation-sigpipe"],
            counterevidence: [],
          },
          createContent: null,
          find: "Avoid piping large font listings through head; constrain the query at the source.",
          replace: "Before listing fonts, use a targeted family query or known font path. Do not use a broad fc-list pipeline with head, tail, or grep -m; it can terminate the command with SIGPIPE.",
          expectedOutcome: "Future PDF work chooses a bounded font lookup before invoking the shell.",
          reason: "The loaded rule was ignored, so it needs a more actionable decision-point form.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(decision).toMatchObject({
      decision: "propose",
      target: "instructions/system.md",
    });
    expect(messagesSeen).toHaveLength(2);
    expect(messagesSeen[1]!.at(-1)!.content).toContain("violated a loaded instruction");
  });

  test("requires a model critique before returning a proposal", async () => {
    const messagesSeen: HarnessRefinerMessage[][] = [];
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      stream: async function* ({ messages }) {
        messagesSeen.push(messages);
        if (messagesSeen.length === 1) {
          yield { text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "skill",
            operation: "create",
            target: "skills/chart-label-fix/SKILL.md",
            summary: "Encode the exact chart-label task.",
            evidenceBasis: {
              kind: "single_deterministic",
              supportingEvidenceIds: ["observation-1"],
              counterevidence: [],
            },
            createContent: "---\nname: chart-label-fix\n---\nRepeat this task.",
            find: null,
            replace: null,
            expectedOutcome: "Repeat this specific workflow.",
            reason: "One turn showed a recoverable issue.",
          }) };
          return;
        }
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
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
    expect(messagesSeen[1]!.at(-1)!.content).toContain("invented recurrence");
    expect(messagesSeen[1]!.at(-1)!.content).toContain(
      "Do not reject a concise correction merely because",
    );
  });

  test("fails closed when the final decision invents evidence or selects an unavailable capability", async () => {
    let calls = 0;
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      stream: async function* () {
        calls += 1;
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "propose",
          route: "agent",
          operation: "create",
          target: "agents/chart-reviewer/AGENT.md",
          summary: "Create a chart reviewer.",
          evidenceBasis: {
            kind: "single_deterministic",
            supportingEvidenceIds: ["invented-incident"],
            counterevidence: [],
          },
          createContent: "Review charts.",
          find: null,
          replace: null,
          expectedOutcome: "Future charts are reviewed.",
          reason: "The chart task needs a reusable role.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    expect(decision).toMatchObject({
      decision: "no_action",
      reason: expect.stringContaining("not admitted"),
    });
  });

  test("uses the critique pass to abstain when supplied counterevidence defeats the draft", async () => {
    let calls = 0;
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      stream: async function* () {
        calls += 1;
        if (calls === 1) {
          yield { text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v2",
            decision: "propose",
            route: "skill",
            operation: "create",
            target: "skills/pdf-retry/SKILL.md",
            summary: "Add a PDF retry workflow.",
            evidenceBasis: {
              kind: "single_deterministic",
              supportingEvidenceIds: ["observation-1"],
              counterevidence: ["A later equivalent operation succeeded without the proposed retry."],
            },
            createContent: "---\nname: pdf-retry\n---\nRetry the PDF operation.",
            find: null,
            replace: null,
            expectedOutcome: "Future PDF operations retry automatically.",
            reason: "The first attempt failed.",
          }) };
          return;
        }
        yield { text: JSON.stringify({
          schemaVersion: "openpond.localHarnessRefinerDecision.v2",
          decision: "no_action",
          reason: "The supplied later success contradicts a deterministic reusable retry rule.",
        }) };
      },
      signal: new AbortController().signal,
    });

    expect(calls).toBe(2);
    expect(decision).toMatchObject({
      decision: "no_action",
      reason: expect.stringContaining("contradicts"),
    });
  });

  test("admits external ownership and materially supplied recurrence without treating capabilities as routes", () => {
    const recurrentEvidence: LocalHarnessRefinerEvidence = {
      ...evidence,
      reviewPacket: {
        ...evidence.reviewPacket,
        priorIncidents: [{ id: "incident-2", summary: "A separate task hit the same deterministic boundary." }],
      },
    };
    const route = admitLocalHarnessRefinerDecision({
      evidence: recurrentEvidence,
      decision: {
        schemaVersion: "openpond.localHarnessRefinerDecision.v2",
        decision: "route",
        route: "taskset",
        summary: "The hidden fixture contradicts the stated task.",
        evidenceBasis: {
          kind: "single_deterministic",
          supportingEvidenceIds: ["observation-1"],
          counterevidence: [],
        },
        expectedOutcome: "The Taskset owner repairs the fixture.",
        reason: "The measured failure is outside Harness ownership.",
      },
    });
    const recurrent = admitLocalHarnessRefinerDecision({
      evidence: recurrentEvidence,
      decision: {
        schemaVersion: "openpond.localHarnessRefinerDecision.v2",
        decision: "propose",
        route: "skill",
        operation: "create",
        target: "skills/chart-validation/SKILL.md",
        summary: "Add the repeated chart validation workflow.",
        evidenceBasis: {
          kind: "recurrent_independent",
          supportingEvidenceIds: ["observation-1", "incident-2"],
          counterevidence: [],
        },
        createContent: "---\nname: chart-validation\n---\nValidate chart labels against the requested source.",
        find: null,
        replace: null,
        expectedOutcome: "Future chart tasks validate labels before delivery.",
        reason: "Two supplied independent incidents exhibit the same reusable workflow gap.",
      },
    });

    expect(route.decision).toBe("route");
    expect(recurrent.decision).toBe("propose");
  });
});
