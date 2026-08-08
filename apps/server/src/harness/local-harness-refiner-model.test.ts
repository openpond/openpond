import { describe, expect, it } from "vitest";

import {
  authorLocalHarnessRefinementWithModel,
  DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
  DEFAULT_REFINER_TIMEOUT_MS,
  type LocalHarnessRefinerEvidence,
} from "./local-harness-refiner-model.js";

const evidence: LocalHarnessRefinerEvidence = {
  trigger: { id: "trigger-a" },
  observations: [{ kind: "user_turn", state: "terminal" }],
  task: {
    prompt: "Update the report formatting.",
    assistantOutput: "Updated the report.",
    previousAssistantOutput: "Created the first report.",
  },
  eventExcerpts: [],
  sourceFiles: [
    {
      path: "instructions/system.md",
      kind: "instruction",
      content: "Keep reports concise.\n",
      loaded: false,
    },
  ],
  sourceCatalog: [
    {
      path: "instructions/system.md",
      kind: "instruction",
      loaded: false,
    },
  ],
};

describe("Local Harness Refiner model contract", () => {
  it("requests one exact patch instead of a complete replacement file", async () => {
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      signal: new AbortController().signal,
      stream: async function* ({ messages }) {
        const system = messages[0]?.content ?? "";
        expect(system).toContain("one exact find/replace edit");
        expect(system).toContain("Never return the complete file");
        expect(system).toContain("ordinary successful work is not improvement evidence");
        expect(system).toContain("no Agent source compiler or executor");
        expect(system).toContain("completed refine_request tool call only requests this bounded review");
        expect(system).toContain("Never return no_action merely because refine_request completed");
        expect(system).toContain("downstream receipt review owns recurrence thresholds");
        expect(system).not.toContain("replacementContent");
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v1",
            decision: "propose",
            route: "prompt",
            operation: "update",
            target: "instructions/system.md",
            summary: "Keep report headings stable.",
            createContent: null,
            find: "Keep reports concise.",
            replace: "Keep reports concise and preserve established headings.",
            expectedOutcome: "Later reports retain the requested heading style.",
            reason: "The completed turn provides reusable formatting evidence.",
          }),
        };
      },
    });

    expect(decision).toMatchObject({
      decision: "propose",
      operation: "update",
      find: "Keep reports concise.",
    });
  });

  it("hard-cancels one automatic Refiner request within its total timeout", async () => {
    await expect(
      authorLocalHarnessRefinementWithModel({
        evidence,
        signal: new AbortController().signal,
        timeoutMs: 10,
        stream: async function* ({ signal }) {
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
    ).rejects.toThrow("Harness Refiner timed out after 10ms");
  });

  it("accepts a fenced decision with harmless union fields without a repair call", async () => {
    let calls = 0;
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      signal: new AbortController().signal,
      stream: async function* () {
        calls += 1;
        yield {
          text: [
            "Here is the bounded decision:",
            "```json",
            JSON.stringify({
              schemaVersion: "openpond.localHarnessRefinerDecision.v1",
              decision: "no_action",
              reason: "This is an ordinary successful continuation.",
              route: null,
              summary: null,
              createContent: null,
              find: null,
              replace: null,
            }),
            "```",
          ].join("\n"),
        };
      },
    });

    expect(decision).toEqual({
      schemaVersion: "openpond.localHarnessRefinerDecision.v1",
      decision: "no_action",
      reason: "This is an ordinary successful continuation.",
    });
    expect(calls).toBe(1);
  });

  it("normalizes omitted nullable fields before validating a proposal", async () => {
    const decision = await authorLocalHarnessRefinementWithModel({
      evidence,
      signal: new AbortController().signal,
      stream: async function* () {
        yield {
          text: JSON.stringify({
            schemaVersion: "openpond.localHarnessRefinerDecision.v1",
            decision: "propose",
            route: "memory",
            operation: "create",
            target: "memory/report-format",
            summary: "Remember the durable report format.",
            createContent: "Use the requested report format.",
            expectedOutcome: "Future reports use the durable format.",
            reason: "The user explicitly requested durable behavior.",
          }),
        };
      },
    });

    expect(decision).toMatchObject({
      decision: "propose",
      find: null,
      replace: null,
    });
  });

  it("keeps the production automatic limits small", () => {
    expect(DEFAULT_REFINER_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_REFINER_MAX_OUTPUT_TOKENS).toBe(800);
  });
});
