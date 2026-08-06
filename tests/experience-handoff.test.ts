import { describe, expect, test } from "vitest";
import {
  buildExperienceHandoffMetadata,
  exactExchangeHandoffContext,
  exactExchangeHandoffPrompt,
  outputHandoffPrompt,
} from "../apps/web/src/lib/experience-handoff";

describe("experience handoffs", () => {
  test("snapshots the exact selected exchange and links the source task", () => {
    const messages = [
      { role: "user" as const, content: "Make the survey easier to scan." },
      {
        role: "assistant" as const,
        content: "I would group the responses by theme.",
      },
    ];
    const sourceContext = exactExchangeHandoffContext(messages);

    expect(exactExchangeHandoffPrompt(messages)).toBe(
      `Continue this exact exchange in Work:\n\n${sourceContext}`
    );
    expect(
      buildExperienceHandoffMetadata({
        sourceTaskId: "task_chat",
        sourceExperience: "chat",
        targetExperience: "work",
        sourceMessageIds: ["message_1", "message_2"],
        sourceContext,
        createdAt: "2026-07-28T12:00:00.000Z",
      })
    ).toEqual({
      sourceTaskId: "task_chat",
      sourceExperience: "chat",
      targetExperience: "work",
      sourceMessageIds: ["message_1", "message_2"],
      sourceContext,
      outputId: null,
      outputRevision: null,
      createdAt: "2026-07-28T12:00:00.000Z",
      checkoutMutation: "none",
    });
  });

  test("requires an explicit repository destination before Work source mutation", () => {
    const output = {
      id: "output_1",
      revision: 3,
      title: "survey-report.pdf",
    };
    expect(outputHandoffPrompt(output, "chat")).toBe(
      'Continue from the attached Work output "survey-report.pdf" (revision 3).'
    );
    expect(outputHandoffPrompt(output, "work")).toContain(
      "Choose a Project or repository before making source changes"
    );
    expect(
      buildExperienceHandoffMetadata({
        sourceTaskId: "task_work",
        sourceExperience: "work",
        targetExperience: "work",
        output: { id: output.id, revision: output.revision },
        createdAt: "2026-07-28T12:00:00.000Z",
      }).checkoutMutation
    ).toBe("none");
  });
});
